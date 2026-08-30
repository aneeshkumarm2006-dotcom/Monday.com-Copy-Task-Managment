/**
 * Formatting for connector readings.
 *
 * ---- The one rule this file exists to enforce ------------------------------
 *
 * A RANK OF `null` IS AN ANSWER, NOT A GAP.
 *
 * `project_position_info` returns `status: "ok"` with a null position to mean
 * "this domain does not rank in the top 100", and the provider's own
 * documentation is explicit that it is "a final answer ('not ranking'), NOT a
 * 'still loading' state". Rendering that as an empty cell makes it
 * indistinguishable from a sync that failed — and an SEO team looking at a blank
 * column will assume the integration is broken rather than that the client is
 * not ranking, which is the opposite of the information they needed.
 *
 * So there are THREE outcomes here and they must stay three:
 *
 *   `#4`              — it ranks, and here is where
 *   `Not in top 100`  — the provider answered, and the answer is no
 *   `—`               — we have nothing; the field was absent or never fetched
 *
 * `ranked` on a normalised row is what separates the second from the third, and
 * it exists solely so this function can tell them apart.
 */

/** The three-way rank rendering. See the header. */
export const formatRank = (position, ranked) => {
  if (typeof position === 'number') return `#${position}`;
  if (ranked) return 'Not in top 100';
  return '—';
};

/** True when the provider gave a definite "does not rank" rather than nothing. */
export const isUnranked = (position, ranked) =>
  typeof position !== 'number' && !!ranked;

/**
 * A count, or an em dash.
 *
 * Null is NEVER rendered as 0. On a number line they look identical and they
 * mean opposite things: "this domain gets no organic traffic" and "we could not
 * find the traffic field in an undocumented payload".
 */
export const formatNumber = (value, { compact = false } = {}) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (compact && Math.abs(value) >= 1000) {
    return new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }
  return new Intl.NumberFormat().format(
    Number.isInteger(value) ? value : Math.round(value * 100) / 100
  );
};

/** A dollar amount, or an em dash. The provider quotes CPC and value in USD. */
export const formatMoney = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 100 ? 2 : 0,
  }).format(value);
};

/**
 * How a keyword moved, as a colour and a sentence.
 *
 * Rank is inverted — 3 is better than 8 — and `change` is `previous - current`,
 * so a POSITIVE number is an improvement. That convention is set once in the
 * server's normaliser and read here; flipping either half turns every green
 * arrow red.
 *
 * `entered` and `lost` are kept distinct from a numeric change on purpose:
 * crossing into or out of the top 100 has no previous or current rank to
 * subtract from, and collapsing them to "no change" would hide the two biggest
 * events that can happen to a keyword.
 */
export const MOVEMENT = {
  up: { label: 'Up', tone: 'positive', arrow: '▲' },
  down: { label: 'Down', tone: 'negative', arrow: '▼' },
  flat: { label: 'No change', tone: 'neutral', arrow: '–' },
  entered: { label: 'Entered top 100', tone: 'positive', arrow: '▲' },
  lost: { label: 'Left top 100', tone: 'negative', arrow: '▼' },
  none: { label: 'Not ranking', tone: 'neutral', arrow: '' },
};

export const movementOf = (row) => MOVEMENT[row?.movement] || MOVEMENT.none;

export const toneColor = (tone) => {
  if (tone === 'positive') return 'var(--color-card-green)';
  if (tone === 'negative') return '#DC2626';
  return 'var(--color-text-muted)';
};

/**
 * "24 Aug 2026" from an ISO day or a date.
 *
 * Rendered in the reader's own locale but from a UTC instant, because a
 * snapshot's period is a fact about when the provider read the SERP and not
 * about who is looking at it.
 */
export const formatDay = (value) => {
  if (!value) return '';
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

/**
 * How stale a reading is, in words.
 *
 * Worth showing next to every section: rankings at Ubersuggest move once a week
 * on every plan, so "collected 6 days ago" is normal and reassuring rather than
 * alarming — and "collected 3 months ago" is the only visible sign that a
 * connector stopped working.
 */
export const staleness = (value, now = Date.now()) => {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.floor((now - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
};

/**
 * A variant key as prose, or the raw key when it is not a shape we know.
 *
 * ---- TWO providers mint variant keys, and they are not the same shape -------
 *
 * The first spells it `device|lang|locationId` (`desktop|en|2840`), with
 * `default` for every kind that takes only a subject. The second spells it
 * `locationCode|languageCode|device` (`2840|en|desktop`) — its API takes the
 * location first and its key follows its API, and from phase 2 that key is half
 * the identity of an open billable task, so neither is going to be renamed to
 * match the other.
 *
 * They are told apart by the only thing that distinguishes them without
 * guessing: A LOCATION CODE IS NUMERIC AND A DEVICE IS NOT. Read the wrong way
 * round, `2840|en|desktop` renders as "2840 · EN · loc desktop", which is not a
 * market anybody can recognise — and this label ends up in a table caption, in a
 * PDF subtitle and in a column of every exported spreadsheet.
 *
 * `any` is the DataForSEO Labs device: those endpoints take a location and a
 * language and no device at all, so the segment is collapsed rather than
 * invented, and it is rendered as "all devices" rather than dropped — a market
 * with no device dimension is a fact about the data, not a missing field.
 *
 * ---- And the key with no market in it at all -------------------------------
 *
 * Phase 7's Backlinks kinds collapse every dimension: the API takes no location,
 * no language and no device, because a backlink profile is a property of a
 * domain. Their variant is therefore `0|any|any`, and read through the rules
 * above that renders as "all devices · loc 0" — a location code of nought,
 * printed in a PDF subtitle and in a column of every exported sheet. It is named
 * here instead, because a key that means "there is no market dimension" deserves
 * a phrase rather than a fallback.
 */
export const DOMAIN_VARIANT_KEY = '0|any|any';

export const marketLabel = (variant) => {
  if (!variant || variant === 'default') return 'Default';
  if (variant === DOMAIN_VARIANT_KEY) return 'Whole domain';

  const parts = String(variant).split('|');
  const numericFirst = /^\d+$/.test(parts[0] || '');
  const [device, lang, loc] = numericFirst
    ? [parts[2], parts[1], parts[0]]
    : [parts[0], parts[1], parts[2]];

  return (
    [
      device && device !== 'any' ? device : device === 'any' ? 'all devices' : null,
      lang && lang !== 'any' ? lang.toUpperCase() : null,
      loc && loc !== 'any' ? `loc ${loc}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || String(variant)
  );
};

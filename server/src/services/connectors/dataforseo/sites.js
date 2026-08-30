const ConnectorProject = require('../../../models/ConnectorProject');
const C = require('./constants');
const { findSearchOperators, operatorRefusal } = require('./operators');

/**
 * Sites — a `ConnectorProject` that nobody else authored.
 *
 * ---- Why this provider has to invert the mirror ----------------------------
 *
 * `ConnectorProject` exists because Ubersuggest HAS projects: a domain, its
 * keyword list and its tracked locales all live at the provider, and the row
 * here is a cache of somebody else's record so the tab can render without
 * spending quota.
 *
 * DataForSEO has no such concept. It is a stateless billing API: you name a
 * keyword, a location, a language and a device on every single call, and it
 * remembers nothing between them. There is no `list_projects` to mirror, and
 * there never will be.
 *
 * So the row becomes the ORIGINAL rather than the copy. A Site is authored here
 * — a domain, its (location, language, device) targets, its keywords and its
 * competitors — and `externalId` is set to OUR OWN id, because the provider has
 * no id to offer and the field is required, indexed and unique per account.
 * `listProjects` below then reads our own rows back, which is what makes
 * `projectMirror` degenerate into a reconciliation that can never mark anything
 * `missing`: nothing can vanish from a listing we ourselves produce.
 *
 * The consequence worth stating out loud: THIS FILE READS OUR DATABASE FROM
 * INSIDE A PROVIDER DIRECTORY, which no other provider does and which would be a
 * layering violation if it were a shortcut. It is not a shortcut — it is the
 * honest shape of a provider with no remote object to mirror, and the
 * alternative (a `locallyAuthored` branch inside `projectMirror`) would put
 * provider knowledge into the generic engine, which is the one thing the whole
 * registry seam exists to prevent.
 *
 * ---- Why `trackedKeywords` is a real field and not `raw` -------------------
 *
 * `planProjectWork` gates a kind on `project[kind.requires]`, and phase 3's
 * budget has to be able to ask "how many keywords is this org about to buy" in
 * one query rather than by loading every project and counting inside a `Mixed`
 * blob. `__sketch__/ads.js` recorded the same conclusion from the other side:
 * values in `raw` cannot be indexed, cannot be queried, and are not normalised
 * on the way in. Two hundred keywords that drive a cost decision are not display
 * data.
 */

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

/** Hostname characters, at least one dot, no leading or trailing hyphen. */
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/**
 * A domain, from whatever somebody pasted.
 *
 * Accepts a full URL and keeps only the host, because "paste the site" produces
 * `https://www.acme.com/pricing?utm=x` far more often than it produces
 * `acme.com`.
 *
 * `www.` is deliberately NOT stripped. For a rank tracker the two are different
 * targets — a SERP result on `www.acme.com` is not a result on `acme.com` — and
 * quietly normalising one into the other would make every rank we report subtly
 * about a domain the user did not choose.
 *
 * @param {any} value
 * @returns {string|null} the host, lowercased, or null when it is not one
 */
const normaliseDomain = (value) => {
  let text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;

  // Strip a scheme and anything after the host.
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  text = text.split('/')[0].split('?')[0].split('#')[0];
  // Credentials and a port are not part of the identity.
  text = text.split('@').pop();
  text = text.split(':')[0];
  text = text.replace(/\.$/, '');

  if (!text || text.length > C.MAX_DOMAIN_LENGTH) return null;
  if (!HOSTNAME_RE.test(text)) return null;
  return text;
};

/**
 * One keyword, ready to be sent and ready to be compared.
 *
 * Lowercased and whitespace-collapsed. Google is case-insensitive, so "Best CRM"
 * and "best crm" are one keyword that would otherwise be bought twice — and the
 * same normalisation is what a phase-11 cross-tenant cache would have to key on,
 * which is a reason to settle it now rather than after a hundred thousand rows
 * exist in two spellings.
 *
 * @param {any} value
 * @returns {string}
 */
const normaliseKeyword = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * A stable key for one (location, language, device) target.
 *
 * ---- The rule, and what breaking it costs ----------------------------------
 *
 * IT MUST DERIVE FROM IMMUTABLE INPUTS ONLY. Not the label, which is a display
 * string somebody will rename; not the array index, which shifts the moment a
 * target is removed from the middle of the list.
 *
 * A snapshot is identified by `(project, kind, variant, periodKey)`, and from
 * phase 2 an OPEN TASK is identified by `(project, kind, variant)`. A variant
 * key that shifts is therefore two things at once: a broken history, where one
 * market's trend line silently splits in two, and a cache miss on the open-task
 * gate — which against a provider that bills at POST means a second charge for
 * work already paid for.
 *
 * @param {{locationCode: number, languageCode: string, device: string}} target
 * @returns {string}
 */
const variantKeyFor = (target) =>
  [
    Number(target?.locationCode) || 0,
    String(target?.languageCode || '').toLowerCase() || 'any',
    String(target?.device || 'desktop').toLowerCase(),
  ].join('|');

// ---------------------------------------------------------------------------
// Reading the form
// ---------------------------------------------------------------------------

const fail = (error, code = null) => ({ ok: false, error, code });

/**
 * Validate the keyword list.
 *
 * @param {any} value
 * @returns {{ok: true, keywords: string[]}|{ok: false, error: string, code: string|null}}
 */
const readKeywords = (value) => {
  if (!Array.isArray(value)) {
    return fail('Send the tracked keywords as a list.');
  }

  const keywords = [];
  const seen = new Set();

  for (const entry of value) {
    if (typeof entry !== 'string') {
      return fail('Every tracked keyword has to be text.');
    }
    const keyword = normaliseKeyword(entry);
    if (!keyword) continue;

    if (keyword.length > C.MAX_KEYWORD_LENGTH) {
      return fail(
        `"${keyword.slice(0, 40)}…" is too long — keep a tracked keyword under ` +
          `${C.MAX_KEYWORD_LENGTH} characters.`
      );
    }

    /**
     * The x5-per-operator refusal, enforced HERE — on the server, before the
     * value can be stored — rather than in the form that submitted it. A cost
     * multiplier that only a browser checks is a cost multiplier.
     */
    const operators = findSearchOperators(keyword);
    if (operators.length) {
      return fail(operatorRefusal(keyword, operators), 'SEARCH_OPERATOR');
    }

    if (seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
  }

  if (!keywords.length) {
    return fail('Add at least one keyword to track.');
  }
  if (keywords.length > C.MAX_TRACKED_KEYWORDS) {
    return fail(
      `That is ${keywords.length} keywords. A site can track ${C.MAX_TRACKED_KEYWORDS} — ` +
        'every one of them is bought again on every collection.'
    );
  }

  return { ok: true, keywords };
};

/** Language codes as DataForSEO spells them: `en`, `en-GB`, `zh-Hant`. */
const LANGUAGE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i;

/**
 * Validate the (location, language, device) targets.
 *
 * Every target is a full re-collection of every keyword, so this list is the
 * single biggest multiplier on what a Site costs — which is why it is capped and
 * why the cap is explained rather than silently applied.
 *
 * @param {any} value
 * @returns {{ok: true, targets: Array<Object>}|{ok: false, error: string, code: string|null}}
 */
const readTargets = (value) => {
  if (!Array.isArray(value) || !value.length) {
    return fail('Add at least one location and language to track in.');
  }

  const targets = [];
  const seen = new Set();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail('Every target needs a location and a language.');
    }

    const locationCode = Number(entry.locationCode);
    if (!Number.isInteger(locationCode) || locationCode <= 0) {
      return fail(
        'Every target needs a DataForSEO location code — a whole number like 2840 ' +
          'for the United States.'
      );
    }

    const languageCode = String(entry.languageCode || '').trim();
    if (!LANGUAGE_RE.test(languageCode)) {
      return fail('Every target needs a language code, like "en".');
    }

    const device = String(entry.device || 'desktop').trim().toLowerCase();
    if (!C.DEVICES.includes(device)) {
      return fail(`DataForSEO collects ${C.DEVICES.join(' and ')} only.`);
    }

    const target = {
      locationCode,
      languageCode: languageCode.toLowerCase(),
      device,
      label:
        typeof entry.label === 'string' && entry.label.trim()
          ? entry.label.trim().slice(0, 80)
          : null,
    };

    // Deduped on the VARIANT KEY, not on the whole object — two entries that
    // differ only by label are one target, and storing both would buy the same
    // SERP twice a week forever.
    const key = variantKeyFor(target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }

  if (!targets.length) {
    return fail('Add at least one location and language to track in.');
  }
  if (targets.length > C.MAX_TARGETS) {
    return fail(
      `That is ${targets.length} targets. A site can carry ${C.MAX_TARGETS} — each one ` +
        'buys every keyword again.'
    );
  }

  return { ok: true, targets };
};

/**
 * Validate the competitor list. Optional; an empty list is a valid answer.
 *
 * @param {any} value
 * @param {string} domain - the site's own domain, which is not its competitor
 */
const readCompetitors = (value, domain) => {
  if (value === undefined || value === null) return { ok: true, competitors: [] };
  if (!Array.isArray(value)) return fail('Send the competitors as a list.');

  const competitors = [];
  const seen = new Set();

  for (const entry of value) {
    const host = normaliseDomain(entry);
    if (!host) {
      return fail(`"${String(entry).slice(0, 60)}" is not a domain.`);
    }
    if (host === domain) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    competitors.push(host);
  }

  if (competitors.length > C.MAX_COMPETITORS) {
    return fail(`A site can carry ${C.MAX_COMPETITORS} competitors.`);
  }

  return { ok: true, competitors };
};

/**
 * Read a whole Site out of a request body.
 *
 * Built FIELD BY FIELD from what this provider declares, never from what the
 * request sent — the same direction `readCredentialForm` takes, and for the same
 * reason: the request cannot introduce a property, so nothing unexpected reaches
 * a document that from phase 3 decides what gets bought.
 *
 * A FULL REPLACEMENT, not a patch. An edit that dropped four keywords has to be
 * able to say so, and a partial update of a list is ambiguous in a way that
 * costs money in one direction and loses history in the other.
 *
 * @param {Object} body
 * @returns {{ok: true, values: Object}|{ok: false, error: string, code: string|null}}
 */
const readSiteForm = (body) => {
  if (!body || typeof body !== 'object') return fail('Fill in the site details.');

  const domain = normaliseDomain(body.domain);
  if (!domain) {
    return fail('Enter the site domain, like "acme.com".');
  }

  const keywords = readKeywords(body.trackedKeywords);
  if (!keywords.ok) return keywords;

  const targets = readTargets(body.targets);
  if (!targets.ok) return targets;

  const competitors = readCompetitors(body.competitors, domain);
  if (!competitors.ok) return competitors;

  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 120)
      : domain;

  /**
   * OPTIONAL, and the empty string is the gate.
   *
   * `businessName` is what `business_profile` declares as its `requires`, and it
   * is the only `requires` in this provider's catalog that actually stops
   * anything: `planProjectWork` gates on truthiness, an empty ARRAY is truthy
   * (which is why `trackedKeywords` never gated), and an empty STRING is not.
   * Left blank, no Site ever buys a Maps lookup. See the model header.
   *
   * Not defaulted to the domain. A fuzzy Maps match on a domain returns a card
   * for whatever Google thinks is closest, and a confident card for the wrong
   * business is worse than no card at all.
   */
  const businessName =
    typeof body.businessName === 'string' ? body.businessName.trim().slice(0, 200) : '';

  return {
    ok: true,
    values: {
      name,
      domain,
      businessName,
      trackedKeywords: keywords.keywords,
      targets: targets.targets,
      competitors: competitors.competitors,
      // Kept in step with the lists, because they are what the generic tab
      // renders and what `publicProject` has always carried.
      keywordCount: keywords.keywords.length,
      competitorCount: competitors.competitors.length,
      locations: targets.targets.map((t) => ({
        locId: t.locationCode,
        lang: t.languageCode,
        label: t.label,
      })),
    },
  };
};

// ---------------------------------------------------------------------------
// The mirror, inverted
// ---------------------------------------------------------------------------

/**
 * One stored Site, in the shape `projectMirror` expects a provider listing to
 * arrive in.
 *
 * Note which fields are ABSENT: `trackedKeywords`, `targets` and `competitors`
 * are not here, and that is deliberate. The mirror's `$set` writes exactly the
 * keys it knows about, so anything it is not handed survives a reconciliation
 * untouched — which is what stops a routine refresh from overwriting the
 * authored half of a row with a stale copy of itself.
 */
const toListing = (row) => ({
  externalId: String(row.externalId),
  name: row.name || row.domain || '',
  domain: row.domain || null,
  keywordCount: Array.isArray(row.trackedKeywords) ? row.trackedKeywords.length : null,
  competitorCount: Array.isArray(row.competitors) ? row.competitors.length : null,
  locations: (Array.isArray(row.targets) ? row.targets : []).map((t) => ({
    locId: t.locationCode ?? null,
    lang: t.languageCode ?? null,
    label: t.label ?? null,
  })),
  hasBrand: false,
  // There is no provider payload to keep. `raw` exists to record what an
  // undocumented API actually returned, and nothing here came from an API.
  raw: null,
});

/**
 * The descriptor's `listProjects` — our own rows, read back.
 *
 * This is the whole of "the mirror degenerates to a reconciliation that never
 * marks anything missing". `diffProjects` computes `goneIds` as the stored rows
 * absent from the listing, and a listing built FROM the stored rows cannot omit
 * one. `missing` is therefore unreachable by construction rather than by a
 * `if (provider === …)` in the generic file, which is the property worth having.
 *
 * @param {Object} session - services/connectors/session.js
 * @returns {Promise<{projects: Array<Object>, raw: null}>}
 */
const listProjects = async (session) => {
  const rows = await ConnectorProject.find({
    account: session.accountId,
    provider: 'dataforseo',
  })
    .select('externalId name domain trackedKeywords targets competitors')
    .lean();

  return { projects: rows.map(toListing), raw: null };
};

/**
 * How a kind fans out for one Site.
 *
 * EVERY kind does, which is the opposite of the first provider — there, only
 * rank tracking was device-aware and everything else took a bare subject. Here
 * the location and the language are required arguments on every SERP and Labs
 * call there is, so a Site with two markets is two of everything.
 *
 * ---- The `kindKey` argument stopped being ignored in phase 6 ---------------
 *
 * Phase 1 accepted it and did nothing with it, and said why: "the signature is
 * the generic planner's, and a kind that one day needs a narrower fan-out is a
 * change in here rather than a change in the planner". That day is the Labs
 * pack.
 *
 * A SERP variant is `(location, language, DEVICE)` because a desktop ranking and
 * a mobile ranking are two different measurements. LABS HAS NO DEVICE PARAMETER
 * — `keyword_overview`, `competitors_domain`, `domain_intersection` and
 * `relevant_pages` take a location and a language and nothing else. So a Site
 * tracking desktop and mobile in one country would fan a Labs kind out to two
 * identical calls: the same rows bought twice, stored as two snapshots that can
 * never disagree, at double the price, for a distinction the endpoint does not
 * make.
 *
 * `variantScope: 'market'` collapses them, and the collapsed key is minted by
 * the SAME `variantKeyFor` with `device: 'any'` rather than by a second
 * spelling. That matters: the key is half the identity of an open `DfsTask` and
 * the whole identity of a snapshot row, and a key minted two ways is a history
 * that silently splits in two.
 *
 * @param {string} kindKey
 * @param {Object} project - a ConnectorProject row
 * @returns {{variants: Array<Object>, skipped: number}}
 */
const variantsFor = (kindKey, project) => {
  const targets = Array.isArray(project?.targets) ? project.targets : [];

  /**
   * `getKind` is required LAZILY, because `kinds.js` requires `constants.js`
   * and this file is on the same load path — a top-level require here would
   * make the two files' order of evaluation load-bearing for no benefit. The
   * lookup happens once per project per kind, which is nothing.
   */
  const { getKind } = require('./kinds');
  const scope = getKind(kindKey)?.variantScope;

  /**
   * DOMAIN-SCOPED: ONE variant, whatever the Site's targets say.
   *
   * Checked before the targets are even read, because a Backlinks kind does not
   * read them. The Backlinks API takes no location, no language and no device —
   * a backlink profile is a property of a domain and there is no such thing as
   * its US-desktop version.
   *
   * The money this line is: a Site with four targets would otherwise buy the
   * SAME profile four times on every collection, and store it as four snapshots
   * that can never disagree. Agreement between duplicates looks like
   * correctness, so nothing on the screen would ever say so — the only symptom
   * is a bill that is 4x what the screen shows.
   *
   * Minted through `variantKeyFor` like every other key, with every dimension
   * collapsed rather than the format changed, so one function is still the only
   * place a variant key is spelled.
   */
  if (scope === 'domain') {
    const target = { locationCode: 0, languageCode: 'any', device: 'any' };
    return {
      variants: [{ key: variantKeyFor(target), ...target, label: null }],
      skipped: 0,
    };
  }

  if (!targets.length) {
    /**
     * A Site with no targets cannot be collected at all — DataForSEO requires a
     * location and a language on every call, and there is no default that would
     * be honest.
     *
     * `readTargets` refuses to save a Site without one, so this is only
     * reachable through a hand-edited document. Be aware of what it does when it
     * is reached: `planProjectWork` iterates the variants, finds none, and moves
     * on WITHOUT a skip note — its note is driven by `skipped`, which counts
     * variants dropped by a cap, and inflating it here would print "0 further
     * locations not polled".
     *
     * PHASE 2: a kind must not lean on `requires: 'targets'` to cover this.
     * `planProjectWork` gates on `project[kind.requires]` being truthy, and an
     * EMPTY ARRAY IS TRUTHY — the same trap `trackedKeywords` carries, recorded
     * on the model. Check the length inside the fetcher and return a `pending`
     * result carrying a note, which is the one channel that survives to a person.
     */
    return { variants: [], skipped: 0 };
  }

  const usable = targets.slice(0, C.MAX_TARGETS);
  const marketScoped = scope === 'market';

  const variants = [];
  const seen = new Set();
  for (const t of usable) {
    // The device is collapsed rather than dropped, so the key keeps its shape
    // and `variantKeyFor` stays the only place a key is ever minted.
    const target = marketScoped ? { ...t, device: 'any' } : t;
    const key = variantKeyFor(target);
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({
      key,
      locationCode: target.locationCode,
      languageCode: target.languageCode,
      device: target.device,
      label: target.label || null,
    });
  }

  return {
    variants,
    skipped: Math.max(0, targets.length - usable.length),
  };
};

module.exports = {
  normaliseDomain,
  normaliseKeyword,
  variantKeyFor,
  readKeywords,
  readTargets,
  readCompetitors,
  readSiteForm,
  listProjects,
  variantsFor,
  toListing,
};

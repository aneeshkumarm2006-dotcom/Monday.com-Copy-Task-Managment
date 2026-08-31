const C = require('./constants');

/**
 * The dashboard screens this provider can render, as DATA.
 *
 * ---- Why this is a catalog and not a list in the client ---------------------
 *
 * Exactly the argument `./kinds.js` already makes for snapshot kinds, applied
 * one layer up. Three different things have to agree about what a screen is —
 * the client (which renders a nav entry and a component per screen),
 * `BoardConnector.enabledScreens` (which narrows them per board), and the
 * controller (which refuses to store a key no provider declares) — so the
 * catalog is a plain array that serialises straight to the client and the client
 * is a lookup against it rather than a hardcoded list that drifts.
 *
 * A client with no component for a declared screen NAMES it rather than dropping
 * it, the same way `ConnectorDataTab` already treats an unknown kind. That is
 * what makes phases 6-8 additive: a screen added here appears in the nav, in the
 * per-board switches and in the export the day it is declared, and shipping the
 * component is the only remaining work.
 *
 * ---- `kinds` here is a DISPLAY dependency, never a purchase ----------------
 *
 * A screen naming `positions` means "this screen draws that snapshot". It does
 * NOT cause `positions` to be collected — `BoardConnector.kinds` decides that,
 * it is unioned across every board mapping the project, and a screen switched on
 * for a board whose kinds exclude what it draws renders an honest "nothing is
 * being collected for this" instead of an empty page. Keeping the two apart is
 * the whole reason `enabledScreens` is a second field; see the model header.
 */

/**
 * @typedef {Object} DashboardScreen
 * @property {string} key      - stored in `BoardConnector.enabledScreens`
 * @property {string} label    - the nav entry
 * @property {string|null} group - which `SCREEN_GROUPS` heading it sits under
 * @property {string} blurb    - one line, under the heading
 * @property {string[]} kinds  - snapshot kinds this screen DRAWS. Display only.
 * @property {boolean} alwaysOn - cannot be switched off per board
 */

/**
 * The nav headings the screens above are filed under, in the order they appear.
 *
 * ---- Why the grouping is here and not in the client -------------------------
 *
 * The same argument the catalog itself already makes, one field along. Fourteen
 * screens in one flat row is a nav nobody can scan, so the shell renders a
 * grouped rail — and if the grouping were a lookup table in the client, a screen
 * added HERE in a later phase would appear in the nav filed under nothing until
 * somebody remembered to edit a second file. `group` travelling with the screen
 * is what keeps "declare it and it appears, in the right place" true.
 *
 * A screen whose `group` is null is a TOP-LEVEL entry, rendered above the first
 * heading — that is Overview, and it is deliberately not filed under a heading
 * of one. A screen naming a group that does not exist here is filed under a
 * trailing "More" heading by the client rather than dropped, which is the same
 * treatment an unknown screen key already gets.
 *
 * @type {{key: string, label: string}[]}
 */
const SCREEN_GROUPS = [
  { key: 'rankings', label: 'Rankings' },
  { key: 'research', label: 'Research' },
  { key: 'links', label: 'Link building' },
  { key: 'site', label: 'Site & local' },
  { key: 'reporting', label: 'Reporting & spend' },
];

/** @type {DashboardScreen[]} */
const SCREENS = [
  {
    key: 'overview',
    group: null,
    label: 'Overview',
    blurb:
      'Where this site stands right now — how many tracked keywords rank, how ' +
      'that moved since the last collection, and what is still in flight.',
    kinds: ['positions', 'movement'],
    alwaysOn: false,
  },
  {
    key: 'rank_tracking',
    group: 'rankings',
    label: 'Rank tracking',
    blurb:
      'Every tracked keyword, sortable and exportable, with the stored history ' +
      'behind any one of them.',
    kinds: ['positions', 'movement'],
    alwaysOn: false,
  },
  {
    key: 'keyword_research',
    group: 'research',
    label: 'Keyword research',
    blurb:
      'Volume, difficulty, intent and seasonality for every tracked keyword. ' +
      'Competitive index, updated weekly — a database, not a fresh SERP.',
    kinds: ['keyword_metrics'],
    alwaysOn: false,
  },
  {
    /**
     * Competitors and the keyword gap on ONE screen, deliberately.
     *
     * They are two purchases and two snapshot kinds, and they are one question:
     * who else is on these SERPs, and what are they winning that we are not. A
     * competitor table with no gap beside it is a list of names, and a gap table
     * with no competitor table above it is a list of keywords whose relevance
     * nobody can judge. Splitting them would also double the nav for a pair of
     * panels nobody reads apart.
     *
     * `kinds` naming both is a DISPLAY dependency: a board whose `kinds` include
     * `competitors` but not `keyword_gap` gets the top half and an honest note
     * about the bottom half, rather than an empty page.
     */
    key: 'competitors',
    group: 'research',
    label: 'Competitors & gap',
    blurb:
      'Who else owns these SERPs, and the keywords they rank for that this ' +
      'site does not. Competitive index, updated weekly.',
    kinds: ['competitors', 'keyword_gap'],
    alwaysOn: false,
  },
  {
    key: 'top_pages',
    group: 'research',
    label: 'Top pages',
    blurb:
      "This site's own URLs ranked by estimated traffic value, with the " +
      'position profile behind each one. Competitive index, updated weekly.',
    kinds: ['top_pages'],
    alwaysOn: false,
  },
  {
    /**
     * The four Backlinks kinds on ONE screen, deliberately — and the reasoning
     * is the competitors/gap argument again, one API over.
     *
     * A profile hero with no growth chart under it is a number nobody can judge;
     * a referring-domains table with no profile above it is a hundred rows out
     * of a possible twelve thousand with nothing saying so; and an anchor cloud
     * on its own is a word picture with no link count to anchor it. They are
     * four purchases and four snapshot kinds because they are four calls and the
     * calls are the bill — and they are one question.
     *
     * `kinds` naming all four is a DISPLAY dependency: a board whose kinds
     * exclude `anchors` gets everything else and an honest note where the cloud
     * would be, rather than an empty page.
     *
     * ---- The word this blurb is allowed to use, and the three Labs ones are
     * not ---------------------------------------------------------------------
     *
     * LIVE. Labs is a database whose age DataForSEO's own docs put at both
     * "weekly" and "30-90 days", so its three screens say "competitive index"
     * and carry a rebuild date. The backlink index is rebuilt continuously and
     * DataForSEO lists Backlinks among its live-only families. The caveat the
     * screen still prints: the per-domain recrawl interval is undocumented, so
     * this is a claim about the index and not a promise about one link in it.
     */
    key: 'backlinks',
    group: 'links',
    label: 'Backlinks',
    blurb:
      'Who links to this site and how that is moving — the live link profile, ' +
      'two years of growth, the referring domains and the anchor text.',
    kinds: ['backlinks_summary', 'backlinks_timeseries', 'referring_domains', 'anchors'],
    alwaysOn: false,
  },
  {
    /**
     * One kind, one screen, and every panel on it comes out of the same crawl.
     *
     * That is the opposite of the Backlinks screen above, which draws four
     * kinds, and the difference is the API's economics rather than a change of
     * taste: on Backlinks the CALLS are the bill, so four kinds let a board drop
     * one and save money. On OnPage the CRAWL is the bill and every read of its
     * output is free, so splitting the audit would buy a second crawl of the
     * same site to draw a second panel.
     *
     * ---- The word this blurb may not use ------------------------------------
     *
     * Neither "live" nor "competitive index". A crawl is neither: it is a
     * measurement we ordered, of one site, on a day, at a pinned crawl size -
     * and the crawl size is part of the reading, because `onpage_score` is
     * sample-size dependent by DataForSEO's own admission. So the caption on
     * this screen stamps the crawl, and the screen refuses to draw a change
     * between two readings taken at different sizes.
     */
    key: 'site_audit',
    group: 'site',
    label: 'Site audit',
    blurb:
      'The technical state of the site from a crawl of up to ' +
      `${C.ONPAGE_MAX_CRAWL_PAGES} pages \u2014 the health score, every issue ` +
      'counted against the pages it affects, and the worst pages behind it.',
    kinds: ['site_audit'],
    alwaysOn: false,
  },
  // -------------------------------------------------------------------------
  // Phase 10 — Extras. Six screens; four of them buy nothing at all.
  //
  // This is where `enabledScreens` finally earns the field. Everything below
  // reads snapshots some other screen already pays for, or (in two cases) one
  // cheap kind of its own — so a board switches these on and off freely, and
  // narrowing them CANNOT reach a co-tenant board the way narrowing `kinds`
  // would. That separation is the whole reason the two fields exist; see the
  // model header and the top of this file.
  // -------------------------------------------------------------------------

  {
    /**
     * AI VISIBILITY, and its marginal API cost is zero.
     *
     * `ai_overview` rides inside the SERP payload the rank tracker already buys,
     * so this screen is a reading of `positions` and nothing else. There is no
     * AI kind, no AI endpoint and no AI charge — `load_async_ai_overview` is
     * deliberately off, and `constants.AI_OVERVIEW_ASYNC_LOAD` records why.
     *
     * ---- The word this screen may not use ----------------------------------
     *
     * "AI visibility", as a single number. CITED (our domain is in Google's
     * reference list) and MENTIONED (our brand word appears in the prose) are
     * different metrics with different fixes — link-earning against entity
     * coverage — and a blended percentage moves for either reason and tells a
     * reader to do neither. They are two tiles, two columns and two goal fields,
     * all the way down.
     */
    key: 'ai_visibility',
    group: 'rankings',
    label: 'AI visibility',
    blurb:
      'Which tracked keywords now show an AI Overview, whether Google cites ' +
      'this site in it, whether it names the brand without citing it, and who ' +
      'else it cites instead.',
    kinds: ['positions'],
    alwaysOn: false,
  },
  {
    /**
     * CANNIBALIZATION, and it is free for the same reason and a second one.
     *
     * Free because it comes out of the weekly `depth: 100` census that is
     * already bought — more than one of our own URLs on one SERP is a fact
     * sitting in a payload nobody was reading. And free because the deep crawl
     * is what makes it MEANINGFUL: a second URL of ours at position 47 is
     * invisible to the daily ten-deep check, which is why this screen draws
     * `positions` and deliberately not `movement`.
     */
    key: 'cannibalization',
    group: 'rankings',
    label: 'Cannibalization',
    blurb:
      'Keywords where more than one page on this site is competing for the ' +
      'same result, with the positions each one holds.',
    kinds: ['positions'],
    alwaysOn: false,
  },
  {
    /**
     * TOXIC BACKLINKS — the one Extras screen with a purchase behind it.
     *
     * Two kinds and two questions. `referring_domains` is already bought by the
     * Backlinks screen and carries the per-domain signals; `referring_networks`
     * is new, costs one Backlinks request a week, and answers the question
     * per-domain spam scoring structurally cannot: how many of these referrers
     * sit on one IP block.
     *
     * A board whose kinds exclude `referring_networks` gets the domain half and
     * an honest note where the subnet panel would be — the same display
     * dependency the Backlinks and Competitors screens already rely on.
     */
    key: 'toxic_backlinks',
    group: 'links',
    label: 'Toxic backlinks',
    blurb:
      'Referring domains that look wrong and why, the IP blocks several of ' +
      'them share, and a disavow file built only from the ones with more than ' +
      'one reason against them.',
    kinds: ['referring_domains', 'referring_networks'],
    alwaysOn: false,
  },
  {
    /**
     * ALERTS. Zero API cost, and it is a screen rather than only a preference
     * for a specific reason.
     *
     * The notification is the delivery, but a bell message is one line and it
     * disappears. What the board needs beside it is the standing answer: which
     * rules are armed, what the thresholds are, and what has fired recently —
     * so that "why did I get told about this" and "why was I not told about
     * that" are both answerable without reading source.
     *
     * The per-user off switch is the `seo` notification category, which is a
     * separate mechanism on purpose: this screen governs the BOARD's rules and
     * that preference governs one PERSON's bell.
     */
    key: 'alerts',
    group: 'reporting',
    label: 'Alerts',
    blurb:
      'The rank drops and lost backlinks worth telling somebody about — what ' +
      'the thresholds are, and what has fired.',
    kinds: ['positions', 'movement', 'backlinks_summary'],
    alwaysOn: false,
  },
  {
    /**
     * CLIENT REPORT. Zero API cost, and five widget primitives only.
     *
     * Every number on it has already been bought by another screen; this one
     * arranges them. The five primitives are the whole of the builder — a KPI
     * tile, a table, a line, a bar and a donut — which is the shape Semrush's
     * entire reporting product runs on. The temptation is twenty chart types and
     * the cost of giving in is a report nobody can read twice.
     *
     * `kinds` names the four it draws from so a board collecting none of them is
     * told that rather than shown an empty page.
     */
    key: 'client_report',
    group: 'reporting',
    label: 'Client report',
    blurb:
      'One page a client can be sent — the headline numbers, what moved, and ' +
      'a written summary — exported as a PDF or published to their portal.',
    kinds: ['positions', 'backlinks_summary', 'site_audit', 'keyword_metrics'],
    alwaysOn: false,
  },
  {
    /**
     * LOCAL / GBP, and its one number is deliberately not the star rating.
     *
     * `rating_distribution` is why this screen is worth building: a business at
     * 4.6 over 800 reviews that takes twenty new one-stars moves to 4.53, which
     * rounds to the same 4.5 it showed last month. The average hides the one
     * event a local business actually needs to be told about, and the five
     * counts do not.
     *
     * Gated by `requires: 'businessName'` on the kind rather than by this
     * screen: a screen switch decides what is DRAWN and a board that switched
     * this on without naming a business would otherwise buy an empty Maps
     * lookup every week.
     */
    key: 'local',
    group: 'site',
    label: 'Local / GBP',
    blurb:
      'The Google Business Profile behind this site — the star breakdown ' +
      'rather than the average, the themes Google mined from the reviews, and ' +
      'the businesses it lists beside this one.',
    kinds: ['business_profile'],
    alwaysOn: false,
  },
  {
    /**
     * ALWAYS ON, and the only screen that is.
     *
     * It is the one screen that answers a question about OUR money rather than
     * about a client's rankings: what this board's collections have cost this
     * month, how much of the cap is left, and how much work is bought and not
     * yet delivered. A board able to switch that off could spend against a
     * shared account with the meter hidden, which is precisely the arrangement
     * the budget document exists to prevent.
     */
    key: 'usage',
    group: 'reporting',
    label: 'Usage & spend',
    blurb:
      'What this board has spent at DataForSEO this month, what is still ' +
      'queued, and when the two runners last ran.',
    kinds: [],
    alwaysOn: true,
  },
];

const SCREEN_KEYS = SCREENS.map((s) => s.key);
const BY_KEY = new Map(SCREENS.map((s) => [s.key, s]));

/** @param {string} key @returns {DashboardScreen|null} */
const getScreen = (key) => BY_KEY.get(key) || null;

/** @param {string} key @returns {boolean} */
const isScreen = (key) => BY_KEY.has(key);

/**
 * Which screens a board actually renders.
 *
 * AN EMPTY SELECTION MEANS EVERYTHING, exactly like `resolveKinds` — a board
 * that just switched the connector on has expressed no opinion, and reading that
 * as "render nothing" would leave the tab blank with no error to explain it.
 *
 * An `alwaysOn` screen is added back regardless of the selection, so a stored
 * array written before that flag existed cannot hide the money.
 *
 * @param {string[]} [selected]
 * @returns {DashboardScreen[]}
 */
const resolveScreens = (selected) => {
  const asked = Array.isArray(selected) ? selected.filter(isScreen) : [];
  if (!asked.length) return [...SCREENS];
  const wanted = new Set(asked);
  return SCREENS.filter((s) => s.alwaysOn || wanted.has(s.key));
};

/**
 * The two clocks, as data, for the Usage screen to render.
 *
 * ---- Why they are shown side by side ---------------------------------------
 *
 * Because there are two runners on two schedules and exactly one of them can
 * cost anything, and an operator staring at a spend number needs to know which
 * clock produced the last row. `'17 * * * *'` is the pass that decides to BUY;
 * `'*&#47;10 * * * *'` only collects work already paid for, behind a transport that
 * refuses every endpoint that is not free.
 *
 * The consequence for the copy: A "LAST COLLECTED" LINE MUST NOT READ AS "LAST
 * CHARGED". `DfsTask.costUsd` and `ConnectorBudget` are the money;
 * `DfsTask.items[].readyAt` is the moment WE observed a result, which is
 * diagnostics and nothing else.
 */
const RUNNERS = [
  {
    key: 'sync',
    label: 'Collection pass',
    cron: '17 * * * *',
    everyLabel: 'hourly',
    spends: true,
    blurb:
      'Decides what is stale enough to buy, posts it, and collects whatever is ' +
      'already finished. This is the only runner that can spend.',
  },
  {
    key: 'collect',
    label: 'Result sweep',
    cron: C.COLLECT_CRON_EXPRESSION,
    everyLabel: 'every 10 minutes',
    spends: false,
    blurb:
      'Asks a free endpoint what has finished and stores it. It cannot spend ' +
      'money — its transport refuses every endpoint that is not free.',
  },
];

module.exports = {
  SCREENS,
  SCREEN_GROUPS,
  SCREEN_KEYS,
  getScreen,
  isScreen,
  resolveScreens,
  RUNNERS,
};

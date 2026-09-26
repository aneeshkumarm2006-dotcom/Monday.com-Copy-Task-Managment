const mongoose = require('mongoose');

const Board = require('../models/Board');
const TaskGroup = require('../models/TaskGroup');
const Goal = require('../models/Goal');
const Tracker = require('../models/Tracker');
const AdsBudget = require('../models/AdsBudget');
const Task = require('../models/Task');
const User = require('../models/User');
const ConnectorProject = require('../models/ConnectorProject');
const ConnectorSnapshot = require('../models/ConnectorSnapshot');
const BoardConnector = require('../models/BoardConnector');

const { resolveAccess, resolveOrgAccess } = require('../utils/permissions');
const { scoreGroup, scoreBoard } = require('../utils/goalTypes');
const { monthWindow, rollUp } = require('../utils/adsBudgetPacing');
const { normaliseCurrencyCode } = require('../utils/money');
const { deliveryHolidaysOf } = require('../utils/orgHolidays');
const { doneStatusIdsForBoard } = require('../utils/doneStatus');
const { resolveDigestTimezone } = require('../utils/dueDigest');
const {
  isMonthKey,
  monthKeyOf,
  firstDayKeyOf,
  lastDayKeyOf,
  formatMonth,
} = require('../utils/monthKey');
const { dayKeyOf, dayKeyToUtcRange, addDays, minDayKey } = require('../utils/tzDay');
/**
 * The two dependencies that QUERY are reached through their module object —
 * `deliveryReport.planDelivery(...)`, not a destructured `planDelivery` — so the
 * binding is resolved at CALL time and a test can replace it. That is the same
 * pattern `executiveView.js` uses for `boardGrants`, and it is the difference
 * between "the scorer was never called" being an assertion and being a hope.
 *
 * Everything above is destructured on purpose: those are pure functions with no
 * IO, and stubbing a scorer would turn every assertion about a number into an
 * assertion about the stub. The real one runs, exactly as `executiveView.test.js`
 * lets the real `resolveAccess` run.
 */
const deliveryReport = require('./deliveryReport');
const analyticsReport = require('./analyticsReport');
/**
 * The connector REGISTRY, reached through its module object for the same reason
 * the two above are: `reportWidget` asks a provider's descriptor two questions
 * (does it declare dashboard screens, and do two stored variants answer for each
 * other) and a test must be able to answer them without loading a provider.
 *
 * Note what is NOT required here: no provider directory, no client, no session.
 * This file may name no provider — `utils/connectorProviders.js` says so — and
 * asking the descriptor is what keeps that true.
 */
const connectors = require('./connectors');

/** A constant, so destructuring it costs nothing and cannot go stale. */
const { VALID_RANGES } = analyticsReport;

/**
 * executiveHome.js — THE composer of an executive's home page.
 *
 * One person's home is an ordered list of SECTIONS stored on their
 * `ExecutiveView` profile (`services/executiveView.js` is the only reader and
 * writer of that document). This file turns that list into the page: for every
 * section it checks reach, calls the scorer that already exists, and hands back
 * a fixed envelope the renderer can draw without asking a second question.
 *
 * ---- THIS FILE COMPUTES NOTHING (spec invariant 5) -------------------------
 *
 * Every number on the executive home is produced by the same function that
 * produces it everywhere else in the app:
 *
 *   goal scores      `utils/goalTypes.js`      scoreGroup / scoreBoard
 *   delivery         `services/deliveryReport.js`
 *                    planDelivery -> fetchDeliveryInputs -> evaluatePlans
 *   ads pacing       `utils/adsBudgetPacing.js` monthWindow / rollUp
 *   workspace stats  `services/analyticsReport.js` buildAnalytics
 *   my work          the same `$or` the My Work list is built from
 *
 * The reason is the one `analyticsReport.js` states in its own header and it is
 * worth repeating, because THIS is the screen where it bites: if the home page
 * says a client is at 78% and the board's Goals tab says 74%, neither screen is
 * obviously the liar, and the person looking at them is the person who decides
 * things. Two answers to one question is worse than no answer.
 *
 * So: if you find yourself writing arithmetic over domain data in this file,
 * you are reimplementing a scorer. Stop and call the real one. Reshaping what a
 * scorer returned — dropping a field the home does not draw, keying a list by
 * id — is fine and is most of what the handlers below do.
 *
 * ---- REACH IS CHECKED BY THE COMPOSER, NOT BY THE HANDLERS ----------------
 *
 * Spec invariant 1, and the single most important thing in this file: a section
 * naming a board runs `resolveAccess(board, org, userId).canRead` BEFORE its
 * handler is called at all. The profile is a description of a SCREEN and grants
 * nothing; a board can leave a person's reach on any afternoon, from the board's
 * own share dialog, with no idea that an executive home points at it.
 *
 * The check lives in `compose`, driven by the `boardKey` each registry entry
 * declares, rather than as the first line of each handler. A handler that could
 * forget it is a handler that eventually will, and the failure is silent and
 * severe: a private board's client names, goal targets and spend on a page
 * belonging to somebody who was never given that board. With the gate in the
 * walker, a NEW section type cannot leak by omission — it can only leak by
 * declaring `boardKey: null` while reading a board, which is a visible lie in
 * the registry rather than a missing line in a function.
 *
 * CAN-READ IS ONLY HALF THE GATE. Every OTHER reader of this data asks a second
 * question: `goalController` requires `goal.view`, `scoreboardController` drops
 * the delivery half without `tracker.view`, `adsBudgetController` requires
 * `adsBudget.view`. All three are BOARD_SCOPED (`utils/capabilities.js`), which
 * means they are the two-layer AND and are edited from the permissions matrix —
 * a role is DATA, and an owner who unticks `goal.view` on the executive preset,
 * or an admin who moves somebody to `guest` (which holds none of the three),
 * has said something about that person and expects it to hold everywhere. A
 * composer that asked only `canRead` would keep serving scored percentages and
 * spend for a tab that answers 403 on the board itself. So each registry entry
 * names the capability its data sits behind, and the gate asks both questions
 * off ONE `resolveAccess` call. This is the same reasoning `runWorkspaceNumbers`
 * spells out for `analytics.view`; it applies identically to the board three.
 *
 * Unreadable, deleted, belonging to another workspace, or readable but not
 * through that capability all come back the same way: `state: 'unavailable'`
 * with a human sentence. Never a throw, never a 403 over the whole page.
 *
 * ---- ONE BROKEN SECTION MUST NOT BLANK THE PAGE ---------------------------
 *
 * `compose` wraps every handler in a try/catch and degrades to `unavailable`,
 * logging the real error server-side. This page is the front door of the app
 * for the person it belongs to; "something went wrong" where eight tiles used
 * to be, because one tracker on one board has a shape nobody anticipated, is
 * the difference between a bug report and an outage.
 *
 * ---- WHY SECTION_TYPES AND ITS CONFIG TABLE LIVE HERE ---------------------
 *
 * They were defined in `services/executiveView.js` while this file did not yet
 * exist, with a note saying they would move. This is that move, and
 * `executiveView.js` now re-exports `SECTION_TYPES` from here so nothing that
 * imported it broke.
 *
 * A handler and the shape of the config it reads are one decision. Split across
 * two files they drift in the worst possible direction — the validator accepts a
 * key the handler never reads, or the handler reads a key the validator drops,
 * and in both cases the section renders as though it had been configured
 * differently from how it was. Adding a section TYPE is: one row of
 * `CONFIG_NORMALISERS`, one entry in `HANDLERS`, one client renderer. Nothing
 * else, anywhere. `executiveHome.test.js` asserts the first two stay in step.
 *
 * The dependency runs ONE WAY — `executiveView` requires `executiveHome`, never
 * the reverse — which is why the small coercions below are spelled out here
 * again instead of being imported from there. `compose` is handed the already
 * resolved profile precisely so this file never needs to load one.
 */

// ---------------------------------------------------------------------------
// Limits and defaults for the config table
// ---------------------------------------------------------------------------

/** `workspaceNumbers` falls back to the Analytics page's own default window. */
const DEFAULT_RANGE = '30d';

/** The My Work section's due filter, matching `utils/myWorkFilters.js`. */
const MY_WORK_DUE = ['all', 'today', 'week', 'overdue'];

/** How many rows a My Work section may draw, and its default. */
const MAX_MY_WORK = 50;
const DEFAULT_MY_WORK = 10;

/** A note is a reminder on a dashboard, not a document. */
const MAX_NOTE_TITLE = 120;
const MAX_NOTE_TEXT = 4000;

/**
 * A CPU guard for the delivery section, deliberately NOT the Delivery grid's
 * MAX_CELLS — the same reasoning `controllers/scoreboardController.js` writes
 * out at length, and if anything it applies harder here. That grid's 5,000 is a
 * PAYLOAD limit: it ships every cell to the browser. This section ships no cells
 * at all (see `narrowTrackerRows`), so borrowing 5,000 would refuse a legitimate
 * request — 200 client groups x 31 daily periods is 6,200 — and an executive's
 * home page would carry "unavailable" for the largest board in the workspace,
 * which is the one they most wanted on it.
 */
const MAX_EVAL_CELLS = 20000;

/**
 * THE FIVE REPORT WIDGET TYPES — A MIRROR OF `WIDGETS` IN
 * `client/src/utils/reportWidgets.js`, AND THE SIXTH IS AN EDIT HERE TOO.
 *
 * That module is a CLIENT file. It imports three client utilities to build its
 * guards and the server has no business loading any of it, so there is no import
 * that could keep these two lists in step — the same situation `BOARD_TABS` in
 * `services/executiveView.js` is in with `VIEW_TABS`, and it is handled the same
 * way: NAME the coupling here rather than hide it behind a shared constants file
 * that would still have to be edited twice.
 *
 * It lives server-side because this is the only side that can refuse a bad
 * value. `config.widget.type` is STORED, and a typo saved today is a tile that
 * draws nothing for somebody months from now. `isWidgetType` being the only door
 * into that table is what keeps five from becoming twenty (read that module's
 * header); this list is that door on the write side, and a sixth widget type
 * means editing BOTH — there, to add it, and here, to let it be saved.
 */
const REPORT_WIDGET_TYPES = ['number', 'table', 'line', 'bar', 'donut'];

/** A widget title is a label on a tile, not prose. */
const MAX_WIDGET_TITLE = 120;

/**
 * The snapshot kinds a report is built from — a mirror of `buildReport`, in the
 * same module, under the same obligation as the list above.
 *
 * `buildReport` assembles four sections and every one of them reads one of these
 * four kinds; the other nine kinds a provider can collect (anchors, referring
 * domains, top pages and the rest) appear nowhere in it. Shipping them would be
 * tens of kilobytes per section that nothing draws, on the front door of the
 * app. A fifth report section is an edit here as well as there.
 */
const REPORT_KINDS = ['positions', 'movement', 'backlinks_summary', 'site_audit'];

/**
 * How far back the report's line is drawn, and the ceiling on the query behind
 * it. Both are `connectorDataController`'s own numbers (`DEFAULT_HISTORY_DAYS`,
 * `MAX_HISTORY_ROWS`) because the tile must agree with the tab it links to — a
 * chart whose right edge or whose earliest point moved between the two would be
 * two answers to one question, a click apart.
 */
const REPORT_HISTORY_DAYS = 90;
const MAX_REPORT_ROWS = 400;

/**
 * The board fields this file reads, as one select. Named rather than loading
 * whole documents because the first five are load-bearing in a way that is easy
 * to break: drop any one of them and `resolveAccess` resolves EVERY board to no
 * access, and the whole home page degrades to "you no longer have access" with
 * no error anywhere. `boardController.getDashboardStats` carries the same
 * warning over the same list.
 */
const BOARD_FIELDS = [
  // Exactly what `resolveAccess` reads. Do not trim.
  'visibility',
  'publicDefaultLevel',
  'memberAccess',
  'createdBy',
  'organisation',
  // What the handlers read.
  'name', // every section names its board on screen
  'boardType', // goals, delivery and ads budgets only exist on a tracker board
  'monthTimezone', // `month: null` resolves in the BOARD's timezone, not ours
  'statuses', // trackerEvaluate's done-status test, via utils/doneStatus.js
  'adsBudget', // the currency the pacing tile prints
  'currency', // …and the board's own, read when the Ads Budget names none
].join(' ');

// ---------------------------------------------------------------------------
// Small shared coercions
// ---------------------------------------------------------------------------

/**
 * Coerce a ref that may be an id string, an ObjectId, or a POPULATED document
 * to its id string. `String(doc)` on a populated Mongoose document is its
 * inspect string, never the hex id — the trap `idOf` in utils/permissions.js
 * exists for.
 */
const idOf = (ref) => String(ref?._id || ref || '');

const isId = (v) => !!v && mongoose.Types.ObjectId.isValid(v);

/** `[a, b, a, junk]` becomes `['a', 'b']`: order kept, duplicates and junk gone. */
const idList = (value) => {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const id = idOf(raw);
    if (isId(id) && !out.includes(id)) out.push(id);
  }
  return out;
};

const idOrNull = (value) => {
  const id = idOf(value);
  return isId(id) ? id : null;
};

const emptyToNull = (arr) => (Array.isArray(arr) && arr.length > 0 ? arr : null);

const monthOrNull = (value) =>
  typeof value === 'string' && isMonthKey(value) ? value : null;

const clampText = (value, max) => {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
};

/**
 * An integer inside a range, with BLANK MEANING ABSENT rather than zero.
 *
 * The `Number.isFinite` guard alone is not enough, and the gap is a real one
 * rather than a theoretical tidiness: `Number('')` is 0, and 0 is finite, so a
 * CLEARED number field arrives as a legal value and clamps to `min`. The
 * caller's intent — "I emptied the box, give me the default back" — silently
 * became "give me 1". The config form clears its own field to the default on
 * blur for exactly this reason, but the server is what a hand-built request or
 * an older client reaches, so the rule belongs on both sides of the wire.
 *
 * `null` and `undefined` go the same way for the same reason (`Number(null)` is
 * also 0). Only something that actually parses as a number is clamped.
 */
const clampInt = (value, min, max, fallback) => {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const finiteOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** The board's own timezone, or the honest last resort. */
const tzOf = (board) => board?.monthTimezone || 'UTC';

/** `YYYY-MM-DD`, UTC — the spelling `ConnectorSnapshot.periodKey` is stored in. */
const utcDayKey = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * A stored widget definition, or `null` for one that was never finished.
 *
 * THE TYPE IS THE PART THAT IS REFUSED RATHER THAN COERCED, and it is the one
 * exception to the rule stated over `CONFIG_NORMALISERS` below. Everything else
 * inside a config has a degraded state the composer already handles — a stale
 * board id is `unavailable`, a month with no rows is `empty`. A sixth widget
 * type has none: `buildWidget` THROWS on it (by design, so that adding one is a
 * reviewed decision rather than an object literal), and a saved section that
 * threw inside the renderer would be a broken tile forever. So an unknown type
 * does not survive this function — the whole definition becomes `null`, which is
 * the same shape as a section somebody added and has not configured yet, and the
 * handler says exactly that.
 */
const widgetOrNull = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!REPORT_WIDGET_TYPES.includes(value.type)) return null;
  return {
    type: value.type,
    /**
     * WHICH widget of that type, by the title `buildReport` gave it. A report
     * carries several `number` tiles and the titles are what distinguishes them
     * — `ClientReportScreen` keys its own tiles on `w.title`, so they are unique
     * within a report by construction. Blank is legal and means "the first one
     * of that type", which is what makes a type-only choice a complete answer.
     */
    title: clampText(value.title, MAX_WIDGET_TITLE),
  };
};

// ---------------------------------------------------------------------------
// The config table — and, through its keys, the section types themselves
// ---------------------------------------------------------------------------

/**
 * Per-type normalisation of a section's `config` blob.
 *
 * MOVED HERE FROM `services/executiveView.js` in phase 2 — see the header for
 * why a handler and its config shape belong in one file. `executiveView.js`
 * re-exports `SECTION_TYPES` so its validator, the controller and the client all
 * still read one list.
 *
 * WHY THESE NORMALISE RATHER THAN REJECT. An unknown section TYPE is refused by
 * `validateShape` — that is a client sending something this server cannot draw
 * at all, and storing it would produce a permanently broken tile. Everything
 * INSIDE a config is coerced to the nearest legal value instead, because each of
 * those values already has a degraded state the composer has to handle anyway: a
 * board id that no longer resolves is `state: 'unavailable'`, a month with no
 * rows is `empty`. Rejecting a whole save over one stale id in one section would
 * leave somebody unable to save the eight sections that were fine.
 */
const CONFIG_NORMALISERS = {
  // Empty or absent `boards` means "every board on the profile" — see the
  // spec's config table. That is why an empty array is legal here and is NOT
  // the same statement as an empty tab allowlist: one means all, the other none.
  boardTiles: (c) => ({ boards: idList(c.boards) }),
  // `month: null` means "the board's current month", resolved at compose time
  // in the BOARD's timezone. A resolved month must never be stored back, or the
  // home page pins itself to September forever.
  goalScores: (c) => ({
    board: idOrNull(c.board),
    month: monthOrNull(c.month),
    // `null` is every group; a list narrows it. A list that normalises to
    // nothing becomes `null` rather than `[]`, for the reason above.
    groups: emptyToNull(idList(c.groups)),
  }),
  deliveryScores: (c) => ({ board: idOrNull(c.board), month: monthOrNull(c.month) }),
  adsBudgetPacing: (c) => ({ board: idOrNull(c.board), month: monthOrNull(c.month) }),
  // The range list is IMPORTED from the report rather than retyped: the two
  // lists disagreed once already (a `90d` section reported all-time numbers
  // under a "90 days" heading, silently), and that is precisely the bug one
  // shared table cannot have.
  workspaceNumbers: (c) => ({
    range: VALID_RANGES.includes(c.range) ? c.range : DEFAULT_RANGE,
    board: idOrNull(c.board),
  }),
  myWork: (c) => ({
    due: MY_WORK_DUE.includes(c.due) ? c.due : 'all',
    limit: clampInt(c.limit, 1, MAX_MY_WORK, DEFAULT_MY_WORK),
  }),
  // No query behind this one — the handler echoes it back. Clamped because the
  // whole profile is read on every sign-in and every home compose, and a pasted
  // document in a "note" would ride along on both.
  note: (c) => ({
    title: clampText(c.title, MAX_NOTE_TITLE),
    text: clampText(c.text, MAX_NOTE_TEXT),
  }),
  // One widget off one client's connector report. `group` is required and is
  // NOT optional the way `workspaceNumbers`' board is: a report is built from
  // one site's readings, a site is mapped to a GROUP (`ConnectorProject.group`,
  // unique per provider), and a board-wide report would have to pick a client's
  // numbers and print them under the board's name.
  reportWidget: (c) => ({
    board: idOrNull(c.board),
    group: idOrNull(c.group),
    widget: widgetOrNull(c.widget),
  }),
};

/**
 * The section types, derived from the table above so the list the validator
 * rejects against and the set of configs that can actually be normalised are the
 * same set by construction.
 */
const SECTION_TYPES = Object.keys(CONFIG_NORMALISERS);

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * The sentences a section carries when it cannot be drawn.
 *
 * Written for the person reading the page, not for the developer reading the
 * log — this is the whole visible content of a tile that failed, so "Forbidden"
 * or "CastError" would be worse than nothing. Each one says what happened and,
 * where there is one, implies the fix.
 */
const MESSAGES = {
  NO_BOARD: 'This section has not been given a board yet.',
  BOARD_GONE: 'That board no longer exists in this workspace.',
  NO_ACCESS: 'You no longer have access to this board.',
  UNKNOWN_TYPE: 'This kind of section is no longer available.',
  FAILED: 'This section could not be loaded.',
  NO_ANALYTICS: 'Your role does not include workspace analytics.',
  // The three board-scoped refusals. Separate sentences rather than one generic
  // "your role does not allow this", because the person reading the page is the
  // person who can ask for it back, and "goals" / "delivery" / "ads budgets" is
  // what they would have to name when they do. Each is the home-page voice of a
  // 403 the matching board tab already gives.
  NO_GOAL_CAP: "Your role no longer includes this board's goals.",
  NO_TRACKER_CAP: "Your role no longer includes this board's delivery.",
  NO_ADS_CAP: "Your role no longer includes this board's ads budgets.",
  // Not a permission at all — the add-on is switched off, so the tab this
  // section links to does not exist on that board any more.
  ADS_BUDGET_OFF: 'The ads budget add-on is switched off on this board.',
  // The fourth board-scoped refusal, in the same voice as the three above.
  NO_CONNECTOR_CAP: "Your role no longer includes this board's connector data.",
  // A `reportWidget` that was never finished being configured. Two sentences
  // rather than one, because the person reading the page is the person who
  // opens the configurator, and "a client" and "a widget" are two different
  // controls to go and fill in.
  NO_GROUP: 'This section has not been given a client yet.',
  NO_WIDGET: 'This section has not been given a report widget yet.',
  GROUP_GONE: 'That client is no longer on this board.',
  // Not a permission either — the same shape as ADS_BUDGET_OFF. Readings are
  // kept when a connector is switched off, so without this the tile would go on
  // publishing last month's rankings under an "Open board" link to a tab that
  // no longer exists on that board.
  CONNECTOR_OFF: 'The connector this report is built from is switched off on this board.',
};

/** A handler's three possible answers, so no handler spells the states itself. */
const ok = (data) => ({ state: 'ok', data });
/**
 * Nothing to show — which is NOT the same as `ok` with an empty payload, and
 * the distinction is the renderer's whole job here. "No goals were set for this
 * month" and "here are the goals, and they score zero" are different sentences
 * about a client, and a tile that cannot tell them apart will print the wrong
 * one. The data still rides along so an empty state can name its month.
 */
const empty = (data) => ({ state: 'empty', data });
const unavailable = (error) => ({ state: 'unavailable', data: null, error });

// ---------------------------------------------------------------------------
// Handlers — one per section type
// ---------------------------------------------------------------------------

/**
 * Which month is this section about?
 *
 * `month: null` is "the board's current month", and WHICH DAY IT IS DEPENDS ON
 * WHERE THE BOARD THINKS IT LIVES. `new Date().getMonth()` is the server's month
 * and would roll a board in Auckland into the next one thirteen hours early, and
 * a board in Los Angeles seven hours late — for a whole day, twelve times a
 * year, on a page whose numbers are all per-month.
 *
 * The resolved value is returned to the caller and NEVER written back to the
 * profile. A section that stored the month it happened to be composed in would
 * pin itself to that month forever, and nobody would notice until the following
 * one.
 */
const monthFor = (config, board, now) =>
  monthOrNull(config.month) || monthKeyOf(now, tzOf(board));

/**
 * boardTiles — the profile's boards as cards.
 *
 * No scorer and no query: the batch `compose` already ran is the whole of it.
 * The tiles' progress bars and permissions come from `GET /api/boards`, which
 * the home page already has in its board store and which is itself filtered on
 * `canRead` — so this section names WHICH boards and in what order, and the
 * renderer intersects. That is what stops a second copy of
 * `computeBoardProgress` and a second answer to "how far through is this board".
 *
 * An empty `config.boards` means every board on the profile, per the spec's
 * config table. Either way each id is re-checked here rather than trusted:
 * `compose` may be handed a raw profile as easily as a resolved one, and the
 * resolved one's guarantee is not this function's to assume.
 */
const runBoardTiles = ({ config, profile, readable }) => {
  const entries = Array.isArray(profile?.boards) ? profile.boards : [];
  const wanted = idList(config.boards);

  // The order is the config's when it names boards, and the profile's when it
  // does not — in both cases the order somebody dragged into place.
  const ordered = wanted.length > 0
    ? wanted
      .map((id) => entries.find((e) => idOf(e.board) === id) || { board: id })
      .filter(Boolean)
    : [...entries].sort((a, b) => finiteOr(a.order, 0) - finiteOr(b.order, 0));

  const tiles = [];
  for (const entry of ordered) {
    const board = readable(idOf(entry.board));
    if (!board) continue; // deleted, another workspace, or no longer theirs
    tiles.push({
      board: idOf(board._id),
      // The board's REAL name travels beside the profile's nickname. Which one
      // a surface shows is that surface's decision (phase 3), and it cannot
      // make it if only one of them arrived.
      name: board.name || '',
      label: entry.label || '',
      defaultTab: entry.defaultTab || null,
    });
  }

  const data = { boards: tiles };
  return tiles.length === 0 ? empty(data) : ok(data);
};

/**
 * goalScores — this month's goal roll-up for one board.
 *
 * Follows `controllers/goalController.getGoals`: groups in display order, the
 * month's goals bucketed under them, `scoreGroup` per group and `scoreBoard`
 * over those summaries. Same scorer, same arithmetic, so this tile and that tab
 * cannot disagree.
 *
 * TWO THINGS getGoals DOES THAT THIS DELIBERATELY DOES NOT:
 *
 *  - the six-month sparkline history query. It is the expensive half of that
 *    endpoint (a second scan of the Goal collection across six month keys, then
 *    a per-series sort) and the home draws no sparkline. A home page composes
 *    several sections at once; paying for a chart nobody renders, N times, is
 *    how a front door becomes slow.
 *  - the per-goal rows, columns and owner display. The home shows summaries.
 *    Shipping every goal on a 40-client board would be most of a megabyte for a
 *    tile the size of a postcard.
 *
 * The goals are handed to `scoreGroup` raw: it calls `scoreGoal` itself for any
 * row without a `computed` field, so the decoration getGoals does for its own
 * table is not needed to get the same number.
 */
const runGoalScores = async ({ board, config, now }) => {
  const month = monthFor(config, board, now);
  const wanted = config.groups && config.groups.length > 0
    ? new Set(idList(config.groups))
    : null;

  const [allGroups, goals] = await Promise.all([
    TaskGroup.find({ board: board._id }).select('name order').sort({ order: 1 }).lean(),
    Goal.find({ board: board._id, monthKey: month })
      // Exactly the fields the scorer reads, which is the same select the
      // People scoreboard uses for the same reason.
      .select('group type config unit unitLabel actual actualDayKey weight')
      .lean(),
  ]);

  // A `groups` config narrows the section to some clients. Applied to the GROUP
  // list rather than to the goal rows, so a named group with no goals this month
  // still appears (as an empty ring) — its absence would read as "that client is
  // not on this board".
  const groups = wanted ? allGroups.filter((g) => wanted.has(String(g._id))) : allGroups;

  const byGroup = new Map(groups.map((g) => [String(g._id), []]));
  for (const goal of goals) {
    const rows = byGroup.get(String(goal.group));
    // Goals belonging to a group the config left out are dropped here, which is
    // what keeps the board line below a roll-up of what is ON SCREEN rather
    // than of the whole board.
    if (rows) rows.push(goal);
  }

  const groupRows = groups.map((g) => ({
    _id: String(g._id),
    name: g.name,
    summary: scoreGroup(byGroup.get(String(g._id))),
  }));

  const summary = scoreBoard(groupRows.map((g) => g.summary));
  const data = {
    boardId: idOf(board._id),
    boardName: board.name || '',
    monthKey: month,
    timezone: tzOf(board),
    // The month is still running, so these numbers are a progress report — the
    // same flag the People scoreboard ships, and the renderer's licence to say
    // so beside the ring.
    partialMonth: month === monthKeyOf(now, tzOf(board)),
    groups: groupRows,
    summary,
  };

  // `totalGoals` comes off `scoreBoard`, so "is there anything to show" is
  // answered by the scorer too rather than by a count taken here.
  return summary.totalGoals === 0 ? empty(data) : ok(data);
};

/**
 * Drop the per-cell detail from an evaluated tracker.
 *
 * `evaluatePlans` returns every group x period cell, because the Delivery GRID
 * draws every one of them. The home draws four tiles. On a 40-client board with
 * a daily tracker that is 1,240 objects per tracker per section, and the
 * renderer (`components/board/delivery/DeliverySummary.jsx`) reads exactly
 * `enabled`, `rows[].groupId` and `rows[].summary`.
 */
const narrowTrackerRows = (results) =>
  results.map(({ tracker, rows, summary }) => ({
    _id: String(tracker._id),
    name: tracker.name,
    enabled: tracker.enabled,
    rows: rows.map((row) => ({
      groupId: String(row.groupId),
      groupName: row.groupName,
      summary: row.summary,
    })),
    summary,
  }));

/**
 * deliveryScores — how well one board kept its commitments this month.
 *
 * The delivery block of `controllers/scoreboardController.getScoreboard`,
 * verbatim in shape: plan the periods, fetch the inputs, evaluate. The window is
 * the MONTH, clamped to today so a month still running does not paint the rest
 * of itself as missed.
 *
 * NO SECOND FOLD. The scoreboard re-filters periods to the month afterwards as
 * an assertion; here the row summaries `evaluatePlans` produced are shipped
 * unchanged, because `planDelivery` has already dropped any period whose FIRST
 * day falls before the window (a week straddling 31 August belongs to August)
 * and the summaries are built from exactly the periods that survived. Folding
 * again would mean re-deriving `met` and `missed` in this file, which is the one
 * thing it must not do.
 *
 * THE CAP IS NOT A 400 HERE. `planDelivery` bails out when a tracker spans more
 * group-periods than `maxCells`; the Delivery tab answers that with a 400 and a
 * sentence telling the person to scope the tracker. On a home page that same
 * 400 would take the other seven sections down with it, so it becomes this
 * section's own `unavailable`, carrying the same sentence.
 */
const runDeliveryScores = async ({ board, org, config, now }) => {
  const month = monthFor(config, board, now);
  const tz = tzOf(board);

  const [groups, trackers] = await Promise.all([
    TaskGroup.find({ board: board._id }).select('name order').sort({ order: 1 }).lean(),
    Tracker.find({ board: board._id }).sort({ createdAt: 1 }).lean(),
  ]);

  const base = {
    boardId: idOf(board._id),
    boardName: board.name || '',
    monthKey: month,
    timezone: tz,
    partialMonth: month === monthKeyOf(now, tz),
  };

  // No trackers is not a failure — it is a board nobody has set delivery rules
  // on, which is a sentence the renderer can print.
  if (trackers.length === 0) return empty({ ...base, range: null, trackers: [] });

  const monthFrom = firstDayKeyOf(month);
  const monthTo = lastDayKeyOf(month);

  const { plans, scanFrom, scanTo, overCap } = deliveryReport.planDelivery({
    trackers,
    allGroups: groups,
    now,
    maxCells: MAX_EVAL_CELLS,
    // The workspace holiday calendar, off the org document the caller already
    // loaded. The Delivery grid, the People scoreboard and this section MUST
    // pass the same list or they will quietly disagree about which days were
    // owed — which is why it is merged inside trackerDaysOff.js and never at a
    // call site.
    orgHolidays: deliveryHolidaysOf(org),
    resolveRange: ({ todayKey }) => ({
      from: monthFrom,
      to: minDayKey(monthTo, todayKey),
    }),
  });

  if (overCap) {
    return unavailable(
      `"${overCap.tracker.name}" spans ${overCap.cells} group-periods this month. `
      + 'Scope the tracker to fewer clients.'
    );
  }

  const inputs = await deliveryReport.fetchDeliveryInputs({ board, plans, scanFrom, scanTo });
  const results = deliveryReport.evaluatePlans({ board, plans, now, ...inputs });

  const data = {
    ...base,
    range: { fromDayKey: monthFrom, toDayKey: minDayKey(monthTo, dayKeyOf(now, tz)) },
    trackers: narrowTrackerRows(results),
  };

  // A disabled tracker yields no rows by design, so "every tracker is switched
  // off" and "no tracker covers any group" both land here rather than drawing
  // four confident zeroes.
  const anyRows = data.trackers.some((t) => t.enabled && t.rows.length > 0);
  return anyRows ? ok(data) : empty(data);
};

/**
 * adsBudgetPacing — spend against budget for one board this month.
 *
 * PLATFORM ROWS ONLY (`parent: null`). Campaigns are a breakdown WITHIN a
 * platform and summing both levels double-counts the money — the rule
 * `models/AdsBudget.js` states and `controllers/adsBudgetController.getRoster`
 * repeats. `rollUp` is the only thing that adds anything up, and the board total
 * is that rollup over ALL the rows rather than the sum of per-client rollups:
 * the same number today, and deliberately the same CODE tomorrow, so a change
 * to how a lifecycle is treated cannot make the tile disagree with the tab.
 *
 * THE ADD-ON SWITCH IS PART OF WHETHER THIS DATA EXISTS. `Board.adsBudget.enabled`
 * decides whether the tab exists at all (`models/Board.js`), and every read
 * endpoint gates on it first — `adsBudgetController.gate` answers 404
 * `ADS_BUDGET_OFF`, with `requireOn` false for exactly one caller, the settings
 * endpoint that switches it back on. Rows are NOT deleted when somebody switches
 * the add-on off, so without this check the composer would go on publishing last
 * month's spend for a board whose Ads Budget tab has gone, under an "open in
 * board" link to `?view=adsbudget` that no longer resolves.
 *
 * It is `unavailable` rather than `empty` on purpose. `empty` is this section's
 * word for "nothing budgeted this month", and saying that about a board with
 * rows sitting in the collection would be a false statement about money. The
 * check lives in the handler rather than in the gate because the gate answers
 * questions about REACH, and this is a fact about how the board is configured.
 */
const runAdsBudgetPacing = async ({ board, org, config, now }) => {
  if (!board.adsBudget?.enabled) return unavailable(MESSAGES.ADS_BUDGET_OFF);

  const month = monthFor(config, board, now);
  const tz = tzOf(board);
  // `now` is threaded in rather than left to default, so the whole page is
  // composed against one instant and a test can pin the day of the month.
  const window = monthWindow(month, tz, now);

  const rows = await AdsBudget.find({ board: board._id, monthKey: month, parent: null })
    .select('group allocated spent lifecycle')
    .lean();

  const data = {
    boardId: idOf(board._id),
    boardName: board.name || '',
    monthKey: month,
    monthLabel: formatMonth(month, { long: true }),
    timezone: tz,
    // The same steps as `adsBudgetCurrencyOf` in adsBudgetController: the
    // add-on's own choice, else the board's own currency (an override), else
    // the WORKSPACE's unit — what a following board is in — else dollars. The
    // field defaults to null now, so reading it with a bare `|| 'USD'` put a
    // rupee workspace's spend on this tile in dollars while the tab it links
    // to said rupees.
    currency:
      board.adsBudget?.currency
      || normaliseCurrencyCode(board.currency)
      || normaliseCurrencyCode(org && org.baseCurrency)
      || 'USD',
    window,
    platformCount: rows.length,
    totals: rollUp(rows, window),
  };

  // Nothing budgeted is the `unset` state the roster exists to surface, but on a
  // home tile it is an empty section rather than a confident $0 of $0.
  return rows.length === 0 ? empty(data) : ok(data);
};

/**
 * workspaceNumbers — the Analytics page's four figures.
 *
 * `analytics.view` IS RE-ASKED HERE, on the caller's org role, because a role is
 * data and can be edited in the matrix long after the section was composed. The
 * Executive preset holds it today; an owner who trims the preset tomorrow must
 * not turn this person's home page into a 403. The section simply says the
 * numbers are not theirs to see, and the other seven still render.
 *
 * `canSeeOthers: false`, unconditionally. The four figures in `summary` name
 * nobody; the per-assignee overdue breakdown does, and it is gated on
 * `productivity.view_others`, which this section neither asks for nor needs.
 * Passing false is the fail-closed answer `buildAnalytics` documents, and it
 * means no name can reach this page through a field we forgot to drop.
 */
const runWorkspaceNumbers = async ({ org, userId, config }) => {
  if (!resolveOrgAccess(org, userId).can('analytics.view')) {
    return unavailable(MESSAGES.NO_ANALYTICS);
  }

  const report = await analyticsReport.buildAnalytics({
    org,
    userId,
    // Already normalised to a member of VALID_RANGES by the config table above,
    // which imports that list from the report rather than keeping a copy.
    range: config.range,
    boardFilter: config.board || null,
    canSeeOthers: false,
  });

  // A refusal about the input — a board filter outside this caller's reach, say
  // — comes back as data. It is this section's `unavailable`, not the page's.
  if (report.error) return unavailable(report.error);

  return ok({
    range: config.range,
    boardId: config.board || null,
    // ONLY `summary`. The full payload carries board names, per-board completion
    // rates and an overdue breakdown; the tile draws four numbers.
    summary: report.summary,
  });
};

/**
 * The board ids this caller can read, across the whole workspace.
 *
 * NOT the profile's boards: "my work" is the person's own tasks wherever they
 * are, including a board somebody shared with them directly that never made it
 * onto anybody's curated list.
 *
 * This is the same four-line permission idiom as
 * `controllers/taskController.readableBoardIds`, which is what My Work itself
 * uses and which is private to that module. Exporting it belongs in a commit
 * that owns that file; until then this reads the same fields and asks the same
 * resolver, and the BOARDS come back rather than only their ids because the due
 * filter below needs each board's own "done" status.
 */
const readableBoardsIn = async (org, userId) => {
  const boards = await Board.find({ organisation: org._id }).select(BOARD_FIELDS).lean();
  return boards.filter((b) => resolveAccess(b, org, userId).canRead);
};

/**
 * Turn a due bucket into a `dueDate` range, in the person's own day.
 *
 * WHOSE DAY? `utils/dueDigest.js` already answered that question for the morning
 * digest — the user's synced timezone, else the majority `monthTimezone` among
 * the boards their work sits on, else UTC — and this reuses that answer rather
 * than inventing a second one. A section that called "today" a different day
 * from the digest that emailed them about it would be indefensible.
 *
 * The bucket boundaries match `client/src/utils/taskFilters.js` DUE_BUCKETS, so
 * "Due this week" on the home means what it means on My Work: today through the
 * next seven days inclusive, never the past.
 *
 * Returns `null` for "all", which is no constraint at all.
 */
const dueRangeFor = (due, todayKey, timezone) => {
  if (due === 'all' || !todayKey) return null;
  const today = dayKeyToUtcRange(todayKey, timezone);
  if (!today) return null;
  switch (due) {
    case 'overdue':
      return { $lt: today.start };
    case 'today':
      return { $gte: today.start, $lt: today.end };
    case 'week': {
      const week = dayKeyToUtcRange(addDays(todayKey, 7), timezone);
      return week ? { $gte: today.start, $lt: week.end } : { $gte: today.start };
    }
    default:
      return null;
  }
};

/**
 * The sort `getMyTasks` uses, and the one that applies to rows that HAVE a date.
 * Soonest first; ties broken by newest, so two things due Friday come back in a
 * stable order rather than whatever the index felt like.
 */
const DATED_SORT = { dueDate: 1, createdAt: -1 };

/**
 * Rows with no date have nothing to be soonest about, so they fall to the same
 * tiebreaker `getMyTasks` gives them once they have all tied on a missing
 * `dueDate`. Same order, arrived at explicitly.
 */
const UNDATED_SORT = { createdAt: -1 };

/** One My Work query. Split out because the "all" bucket needs two — see below. */
const findWorkTasks = (filter, sort, limit) =>
  Task.find(filter)
    // The same five populates `getMyTasks` does, with the same field lists — a
    // row on the home page and a row on My Work are the same row, and a renderer
    // shared between them must not find one of them missing its people.
    .populate('assignedTo', 'name profilePic email')
    .populate('createdBy', 'name profilePic email')
    .populate('board', 'name visibility statuses labels boardType')
    .populate('group', 'name')
    .populate('parent', 'name')
    .sort(sort)
    .limit(limit)
    .lean();

/**
 * myWork — the caller's own open work, the same query My Work is built from.
 *
 * BOTH BRANCHES OF THE `$or`, deliberately. Personal tasks (`isPersonal`, no
 * board, no organisation) and tasks assigned to them on boards they can read are
 * both their work, and a section called "My work" that quietly dropped one half
 * would be wrong in a way nobody would think to check.
 *
 * WHAT THIS SKIPS that `getMyTasks` does: `annotateHasSubitems` and
 * `annotateUpdateCounts`, two extra round trips that feed a chevron and a badge
 * the home does not draw.
 *
 * WHAT THIS ADDS: the due filter and the limit, both applied IN THE QUERY. The
 * order matters — filtering after a limit would hand back "the first ten of your
 * tasks, of which three are overdue" under a heading that says Overdue.
 *
 * ---- WHY "all" IS TWO QUERIES ---------------------------------------------
 *
 * And this is the trap that comes with moving selection into the query.
 * `Task.dueDate` has no default, so an undated task simply has no such field,
 * and in BSON ordering a MISSING field sorts BEFORE any Date. `sort({ dueDate:
 * 1 })` therefore puts every undated row at the HEAD of the result.
 *
 * `getMyTasks` gets away with that because it returns everything and the page
 * re-buckets (`MyTasksPage.bucketWorkTasks` → overdue, today, upcoming, and
 * `noDate` LAST). Truncate that same sort to ten rows and the ten you keep are
 * the ten least urgent things the person owns: a home tile of undated notes
 * while five overdue items sit below the cut, invisible, on the one screen
 * bought precisely to surface them.
 *
 * So the "all" bucket is drawn in the order My Work draws it — everything with
 * a date, soonest first, and only then undated rows to fill any remaining room.
 * Two queries, and the second is skipped entirely when the first filled the
 * limit. The other three buckets are already a range on `dueDate`, and a range
 * comparison never matches a missing field (BSON compares within a type), so
 * they contain dated rows only and stay one query.
 */
const runMyWork = async ({ org, userId, config, now }) => {
  const userObjectId = new mongoose.Types.ObjectId(String(userId));

  const [user, boards] = await Promise.all([
    User.findById(userId).select('timezone').lean(),
    readableBoardsIn(org, userId),
  ]);

  const timezone = resolveDigestTimezone(user, boards);
  const todayKey = dayKeyOf(now, timezone);
  const dueRange = dueRangeFor(config.due, todayKey, timezone);

  const personalFilter = { isPersonal: true, createdBy: userObjectId };
  const boardFilter = boards.length > 0
    ? {
      board: { $in: boards.map((b) => b._id) },
      assignedTo: userObjectId,
      isPersonal: { $ne: true },
    }
    : null;

  const branches = [personalFilter, ...(boardFilter ? [boardFilter] : [])];
  const filter = { $or: branches };
  if (dueRange) filter.dueDate = dueRange;

  // A finished task is never "overdue", however long ago it was due — the rule
  // `taskFilters.js` states for the same bucket on My Work. "Done" is per board
  // (`utils/doneStatus.js`), plus the legacy string a personal task carries, so
  // the exclusion is the union across every board in play. Only the overdue
  // bucket needs it: the others are about a date, not about a debt.
  if (config.due === 'overdue') {
    const doneIds = boards.flatMap((b) => doneStatusIdsForBoard(b));
    filter.status = { $nin: [...doneIds, 'done'] };
  }

  let tasks;
  if (dueRange) {
    // One bucket, one query: the range already excludes everything undated.
    tasks = await findWorkTasks(filter, DATED_SORT, config.limit);
  } else {
    // `{ $ne: null }` excludes null AND missing, so this is "has a real date".
    const dated = await findWorkTasks(
      { ...filter, dueDate: { $ne: null } },
      DATED_SORT,
      config.limit
    );
    // Only what is left over, and nothing at all when the dated rows filled the
    // tile — which is the common case for anybody with a full calendar, and the
    // reason this costs one round trip rather than two most of the time.
    const room = config.limit - dated.length;
    // `{ dueDate: null }` is the mirror image: null OR missing, i.e. undated.
    const undated = room > 0
      ? await findWorkTasks({ ...filter, dueDate: null }, UNDATED_SORT, room)
      : [];
    tasks = [...dated, ...undated];
  }

  const data = { due: config.due, limit: config.limit, timezone, todayDayKey: todayKey, tasks };
  return tasks.length === 0 ? empty(data) : ok(data);
};

/**
 * note — a reminder somebody typed, echoed back.
 *
 * Re-clamped on the way out even though the config table clamped it on the way
 * in: a section stored before a limit changed would otherwise ride the old one
 * forever, and `config` is a Mixed field that can also be written by a migration
 * or a fixture.
 */
const runNote = ({ config }) => {
  const data = {
    title: clampText(config.title, MAX_NOTE_TITLE),
    text: clampText(config.text, MAX_NOTE_TEXT),
  };
  return !data.title && !data.text ? empty(data) : ok(data);
};


/**
 * reportWidget - one widget off one client's connector report.
 *
 * ---- A HOME PAGE RENDER BUYS NOTHING. THAT IS THE WHOLE POINT -------------
 *
 * This is the one section type whose data sits behind a provider that BILLS AT
 * THE MOMENT A COLLECTION IS ORDERED. `utils/reportWidgets.js` states the rule
 * its report is written under and `connectorDataController` states it again over
 * its own read path: a page load must never reach a provider, because on this
 * provider a page that fetched on render would BUY SERPS, per viewer, per
 * render. An executive home page composes several sections at once and is the
 * first screen its owner opens every morning, so it is the single worst place in
 * the application for that rule to be broken.
 *
 * So: this handler reads `ConnectorSnapshot`, `ConnectorProject` and
 * `BoardConnector` - three collections in our own database - and nothing else.
 * It opens no session, holds no credential, and calls no provider client. The
 * only thing it asks the connector REGISTRY for is two pure decisions about
 * stored rows (below), neither of which touches the network. Every number that
 * reaches the page came out of a reading the collection pass already paid for,
 * hours or days earlier.
 *
 * ---- THE WIDGET IS BUILT ON THE CLIENT, AND THAT IS THE HONEST ANSWER -----
 *
 * `buildWidget`, `buildReport` and the three `comparability` guards that decide
 * whether two readings may be subtracted all live in
 * `client/src/utils/reportWidgets.js` and the three row modules beside it. There
 * is no server-side builder to reuse - `connectorDataController` ships readings
 * and the Report SCREEN turns them into widgets - so a server that built a
 * widget here would be a SECOND implementation of those guards, which is the one
 * duplication this feature cannot afford: a tile printing a delta that the panel
 * on the board's own Report tab refused to draw, under the same title.
 *
 * This handler therefore ships the READINGS, in exactly the shape
 * `buildReport(data)` consumes, and `ReportWidgetSection.jsx` calls the real
 * `buildReport` on them and picks the widget the config names. Same function,
 * same guards, same refusals - the tile and the tab cannot disagree.
 *
 * ---- WHAT IS MIRRORED FROM `connectorDataController`, AND WHY -------------
 *
 * The fold below - newest reading per kind, the one before it as the baseline,
 * one variant at a time - is that controller's, and this is the third copy of it
 * in the repo (`services/seoAlertRunner.js` holds the second, privately). It is
 * mirrored rather than imported because that controller is one monolithic
 * Express handler whose payload builder is not extracted. The honest fix is the
 * one `analyticsReport.js` already had done to it: lift the body into a service
 * and let the controller become the HTTP wrapper. That is a commit that owns
 * `connectorDataController.js`; until it happens, every rule that MUST match is
 * named on the line that implements it, so a change there is findable from here.
 */
const runReportWidget = async ({ board, config, now }) => {
  // The cheapest refusals first, and both are about a section somebody started
  // and did not finish rather than about anything having gone wrong.
  if (!config.widget) return unavailable(MESSAGES.NO_WIDGET);
  if (!config.group) return unavailable(MESSAGES.NO_GROUP);

  const [groups, projects, links] = await Promise.all([
    // Scoped to the board rather than looked up by id alone: a group id from
    // ANOTHER board would otherwise resolve and name a client who is not on the
    // board this section was just gated against.
    TaskGroup.find({ _id: config.group, board: board._id }).select('name').lean(),
    // A group holds at most ONE project per provider (`ConnectorProject`'s
    // partial unique index on `provider + group`), so this is a short list -
    // one row per provider that has been pointed at this client.
    ConnectorProject.find({ board: board._id, group: config.group })
      .select('name domain provider')
      .lean(),
    // Which connectors this board has switched ON. See `CONNECTOR_OFF` below.
    BoardConnector.find({ board: board._id, enabled: true }).select('provider').lean(),
  ]);

  const group = groups[0] || null;
  if (!group) return unavailable(MESSAGES.GROUP_GONE);

  const base = {
    boardId: idOf(board._id),
    boardName: board.name || '',
    groupId: idOf(group._id),
    groupName: group.name || '',
    // Echoed so the renderer draws what was CONFIGURED rather than guessing from
    // the payload, and so the tile can name a widget it could not find.
    widget: config.widget,
  };

  // No site has ever been mapped to this client. `empty`, not `unavailable`:
  // nothing is broken and nobody lost access - there is simply nothing to report
  // yet, which is a sentence the renderer prints.
  if (projects.length === 0) {
    return empty({ ...base, provider: null, report: null });
  }

  const enabled = new Set(links.map((l) => l.provider));
  const candidates = projects.filter((p) => enabled.has(p.provider));
  /**
   * Mapped, with readings on disk, and the tab that draws them is gone. The same
   * judgement `runAdsBudgetPacing` makes about a switched-off add-on, for the
   * same reason: `empty` is this section's word for "no readings yet", and
   * saying that about a client with a year of rankings in the collection would
   * be a false statement about that client.
   */
  if (candidates.length === 0) return unavailable(MESSAGES.CONNECTOR_OFF);

  /**
   * WHICH provider, when one client has been pointed at two.
   *
   * The Report screen lives on the tab a provider earns by DECLARING dashboard
   * screens - that is the split `BoardDetailPage` makes between its two
   * connector tabs, by capability rather than by name, and this asks the same
   * question of the same descriptor. A provider declaring none renders the
   * generic Data tab, which has no report to open.
   *
   * `[0]` survives as the residue, exactly as it does in that page: two
   * dashboard-shaped providers on one client is not a thing that exists, and the
   * honest fix on the day it does is a picker in the configurator rather than a
   * quiet guess here.
   */
  const project =
    candidates.find((p) => connectors.getConnector(p.provider)?.screens?.length > 0)
    || candidates[0];
  const connector = connectors.getConnector(project.provider);

  const rows = await ConnectorSnapshot.find({
    project: project._id,
    // The four kinds a report is built from. See `REPORT_KINDS`.
    kind: { $in: REPORT_KINDS },
  })
    // `raw` is deliberately absent: it is the provider's payload verbatim, it is
    // bulky, and nothing in a report reads it. The same omission `publicSnapshot`
    // makes for the tab.
    .select('kind variant periodKey collectedAt status data fetchedAt')
    .sort({ periodKey: -1, fetchedAt: -1 })
    .limit(MAX_REPORT_ROWS)
    .lean();

  /**
   * WHICH MARKET. A US rank and a UK rank are two facts, and a tile showing
   * whichever was written most recently would flip between countries week to
   * week. The tab picks `variants.sort()[0]`; this picks the same one, because
   * the tile and the tab it links to must be about the same market - an
   * alphabetical choice that AGREES beats a cleverer one that does not.
   */
  const variant =
    [...new Set(rows.filter((r) => r.kind === 'positions').map((r) => r.variant))]
      .sort()[0] || 'default';

  /**
   * Does a stored row answer for the selected variant? ASKED OF THE PROVIDER.
   *
   * One provider's Labs kinds take a location and a language and no device, so
   * their variant key can never equal a `positions` key; compared literally,
   * every one of those readings is filtered out and the report loses a section.
   * The fallback is the behaviour that existed before `sameVariant` did, so a
   * provider that declares nothing is unaffected by its existence.
   */
  const answersFor = (row) =>
    (typeof connector?.sameVariant === 'function'
      ? connector.sameVariant(row.kind, row.variant, variant)
      : row.kind !== 'positions' || row.variant === variant);

  /** Only what a report reads. `subject` and `note` draw nothing in one. */
  const reading = (row) => ({
    kind: row.kind,
    variant: row.variant,
    periodKey: row.periodKey,
    collectedAt: row.collectedAt || null,
    status: row.status,
    /**
     * The normalised payload, WHOLE. Not narrowed to the fields `buildReport`
     * happens to read, because the three `comparability` guards read others -
     * `depth`, `statusType`, `rankScale`, `configHash`, `crawl.stopReason` - and
     * a field list that missed one would not break a widget. It would make a
     * REFUSAL silently stop happening: a delta drawn here where the Report tab
     * prints a sentence explaining why it cannot be drawn.
     */
    data: row.data ?? null,
  });

  const snapshots = {};
  const previousSnapshots = {};
  for (const row of rows) {
    if (!answersFor(row)) continue;
    if (!snapshots[row.kind]) {
      snapshots[row.kind] = reading(row);
      continue;
    }
    if (previousSnapshots[row.kind]) continue;
    // ONLY A FINISHED READING MAY BE THE BASELINE. A `partial` one is a short
    // collection, and half a keyword list compared with a whole one reports
    // every missing keyword as having fallen out of the rankings.
    if (row.status !== 'ok') continue;
    previousSnapshots[row.kind] = reading(row);
  }

  const from = utcDayKey(new Date(now.getTime() - REPORT_HISTORY_DAYS * 86400000));
  const to = utcDayKey(now);
  /**
   * The rank series the report's one line is drawn from, compacted the way the
   * tab compacts its own: `keywords[]` dropped, because a year of weekly
   * readings over 300 keywords is 15,600 rows of per-keyword detail behind a
   * chart of six numbers a point.
   *
   * `averagePositions` is dropped too, which the tab keeps - the report's line
   * is `totals.averageRank` and it reads no bucket breakdown at any depth. That
   * is a narrowing to ONE consumer, so it is written down: a report line that
   * grows a second series is an edit here as well as there.
   */
  const trend = rows
    .filter(
      (r) => r.kind === 'positions'
        && r.variant === variant
        && r.periodKey >= from
        && r.periodKey <= to
    )
    .map((r) => ({
      periodKey: r.periodKey,
      collectedAt: r.collectedAt || null,
      status: r.status,
      totals: r.data?.totals || null,
    }))
    .reverse(); // oldest first, so a chart draws it unchanged

  const data = {
    ...base,
    provider: project.provider,
    /**
     * Shaped EXACTLY as `buildReport(data)` consumes it, key for key, so the
     * client hands this object to the real builder untouched. `project` carries
     * only the two fields that module's `meta` reads.
     */
    report: {
      project: { name: project.name || '', domain: project.domain || '' },
      variant,
      snapshots,
      previousSnapshots,
      trend,
    },
  };

  // Nothing has been collected for this site yet - the state a client is in for
  // its first week on a board, and a sentence rather than a fault.
  return Object.keys(snapshots).length === 0 ? empty(data) : ok(data);
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * One entry per section type: how it names boards, and what runs it.
 *
 * `boardKey` is the config key holding the ONE board this section is about, and
 * it is what `compose` gates on — see the header for why the reach check lives
 * in the walker rather than at the top of each handler. `null` means the type
 * names no single board.
 *
 * `optionalBoard` marks a type whose board is a NARROWING rather than a subject:
 * `workspaceNumbers` reports on the whole workspace unless it was pointed at
 * one board. Absent, the gate would refuse every such section for the crime of
 * not having been narrowed.
 *
 * `boardListKey` is for the one type that names MANY boards. It does not gate —
 * a tile list drops the boards that are no longer reachable and shows the rest,
 * which is the skip-never-error rule the profile already follows — but it does
 * declare those ids so they join the single board query.
 *
 * `capability` is the SECOND half of the gate: the board-scoped capability the
 * board's own tab requires before it will serve this data, re-asked here for the
 * reason the header gives at length. `capabilityError` is what the tile says
 * when the answer is no. The two travel together, and the test asserts that an
 * entry naming one names the other — a capability with no sentence would refuse
 * the section with a blank explanation.
 *
 * WHY THREE OF THE EIGHT NAME NO CAPABILITY:
 *  - `boardTiles` ships a board's NAME, which is exactly what `GET /api/boards`
 *    already ships to anyone who can read it. There is no narrower capability to
 *    ask about, and `canRead` (applied per tile, in `readable`) is the same gate
 *    the board list itself uses.
 *  - `workspaceNumbers` re-asks `analytics.view` inside its own handler, on the
 *    ORG role, because that is where that capability lives — it is not
 *    BOARD_SCOPED, so the board here narrows a report rather than unlocking one.
 *  - `myWork` and `note` name no board at all.
 *
 * `executiveHome.test.js` asserts this table and `CONFIG_NORMALISERS` name the
 * same set of types, in both directions. That assertion is the point of having
 * a registry at all: adding a section type is a row here, a row there, and a
 * client renderer — never a branch in `compose`.
 */
const HANDLERS = {
  boardTiles: { boardKey: null, boardListKey: 'boards', run: runBoardTiles },
  goalScores: {
    boardKey: 'board',
    // `goalController.gate(req, res, 'goal.view')` — the same question the Goals
    // tab asks before it serves a single score.
    capability: 'goal.view',
    capabilityError: MESSAGES.NO_GOAL_CAP,
    run: runGoalScores,
  },
  deliveryScores: {
    boardKey: 'board',
    // `scoreboardController` omits the delivery half entirely without this one.
    capability: 'tracker.view',
    capabilityError: MESSAGES.NO_TRACKER_CAP,
    run: runDeliveryScores,
  },
  adsBudgetPacing: {
    boardKey: 'board',
    // `adsBudgetController.gate(req, res, 'adsBudget.view')`. Money, explicitly.
    capability: 'adsBudget.view',
    capabilityError: MESSAGES.NO_ADS_CAP,
    run: runAdsBudgetPacing,
  },
  workspaceNumbers: { boardKey: 'board', optionalBoard: true, run: runWorkspaceNumbers },
  myWork: { boardKey: null, run: runMyWork },
  note: { boardKey: null, run: runNote },
  reportWidget: {
    boardKey: 'board',
    // `connectorDataController.gateProvider(req, res, 'connector.view')` - the
    // same question the Report tab asks before it serves a single reading, and
    // the same rung: VIEWING costs nothing because every row comes out of our
    // own database, while ORDERING a collection is `connector.manage`.
    capability: 'connector.view',
    capabilityError: MESSAGES.NO_CONNECTOR_CAP,
    run: runReportWidget,
  },
};

// ---------------------------------------------------------------------------
// Composing
// ---------------------------------------------------------------------------

/** Every board id any section names, plus the profile's own when tiles need them. */
const boardIdsNamedBy = (sections, profile) => {
  const ids = [];
  const add = (value) => {
    const id = idOrNull(value);
    if (id && !ids.includes(id)) ids.push(id);
  };

  for (const section of sections) {
    const entry = HANDLERS[section.type];
    if (!entry) continue;
    const config = section.config || {};
    if (entry.boardKey) add(config[entry.boardKey]);
    if (entry.boardListKey) {
      const listed = idList(config[entry.boardListKey]);
      // An empty list means "every board on the profile" (the spec's config
      // table), so those ids have to join the batch too or the tiles resolve
      // nothing.
      if (listed.length > 0) listed.forEach(add);
      else (profile?.boards || []).forEach((e) => add(e.board));
    }
  }
  return ids;
};

/**
 * Load every board any section names, in ONE query, keyed by id string.
 *
 * N sections must not mean N board queries: a home page with a goal section, a
 * delivery section and an ads section over the same tracker board is one row in
 * the Board collection, and it should be read once. This mirrors
 * `executiveView.loadBoardsById` for the same reasons, including the important
 * one:
 *
 * SCOPED TO THE ORGANISATION. A board id from another workspace would otherwise
 * be resolved against THIS org's roles and grants — the wrong question entirely,
 * and one that can answer "yes" for somebody who happens to be an admin here.
 * Scoping the query means a cross-org id simply does not resolve, and lands in
 * the same `unavailable` as a deleted one, which is the truthful answer: that
 * board is not in this workspace.
 */
const loadBoardsById = async (orgId, ids) => {
  const unique = [...new Set(ids.filter(isId))];
  // No workspace to scope to means no board may resolve — every board section
  // then degrades to `unavailable` rather than issuing an unscoped query or
  // throwing a CastError that would take the whole page with it.
  if (unique.length === 0 || !isId(idOf(orgId))) return new Map();
  const docs = await Board.find({ _id: { $in: unique }, organisation: idOf(orgId) })
    .select(BOARD_FIELDS)
    .lean();
  return new Map(docs.map((b) => [idOf(b._id), b]));
};

/**
 * Resolve one section's board against the batch, or say why it cannot be.
 *
 * THE gate. Four outcomes, and the caller runs no handler for three of them:
 * the id resolved to nothing (deleted, or another workspace), the board is there
 * but this person cannot read it, the board is readable but not through the
 * capability this kind of data sits behind, or here is the board.
 *
 * ONE `resolveAccess` CALL answers both permission questions. It is not a cheap
 * function — it expands the role, resolves the board level and intersects two
 * capability sets — and asking it twice for one section would be two chances for
 * the two answers to be taken from different documents.
 */
const gateBoard = (entry, config, boardsById, org, userId) => {
  const id = idOrNull(config[entry.boardKey]);
  if (!id) {
    // A `workspaceNumbers` section with no board is the whole workspace; every
    // other type with no board was never finished being configured.
    return entry.optionalBoard ? { board: null } : { error: MESSAGES.NO_BOARD };
  }
  const board = boardsById.get(id);
  if (!board) return { error: MESSAGES.BOARD_GONE };
  // THE re-check. Not "is it on their list" — the list is a description — but
  // the two-layer AND, asked fresh, every time, before any scorer runs.
  const access = resolveAccess(board, org, userId);
  if (!access.canRead) return { error: MESSAGES.NO_ACCESS };
  // And the capability the board's own tab requires for this same data. `can`
  // has already intersected the org role with the board level, so a person who
  // holds `goal.view` on their role but only reaches this board at a rung that
  // does not confer it is refused here exactly as they are on the board.
  if (entry.capability && !access.can(entry.capability)) {
    return { error: entry.capabilityError || MESSAGES.NO_ACCESS };
  }
  return { board };
};

/** The composed envelope, exactly as the shared contract fixes it. */
const envelope = (section, index, result) => ({
  // The home subdoc's own `_id` — the only stable identity a section has, and
  // the reason `validateShape` preserves it across a save. Two `note` sections
  // are otherwise indistinguishable, so a client keyed on anything else would
  // lose its place the moment somebody reordered the list.
  id: section._id ? idOf(section._id) : `${section.type}-${index}`,
  type: section.type,
  order: finiteOr(section.order, index),
  width: section.width === 'half' ? 'half' : 'full',
  // The NORMALISED config, not the stored blob. `config` is a Mixed field, so a
  // section written before a key existed is missing it entirely; normalising
  // here means the renderer reads a complete shape and never has to default
  // anything, and it cannot drift from what the validator would have stored
  // because it is the same table. Nothing is written back — see `monthFor`.
  config: CONFIG_NORMALISERS[section.type]
    ? CONFIG_NORMALISERS[section.type](section.config || {})
    : {},
  state: result.state,
  data: result.data === undefined ? null : result.data,
  error: result.error || null,
});

/**
 * Compose one person's home page.
 *
 * @param {Object} org     the LOADED Organisation document, matching
 *   `executiveView.resolveForViewer`'s convention. Taken rather than an id so
 *   the controller loads it once (`loadOrgContext` has already done the
 *   membership check and the `ensureSystemRoles` heal by the time we are here)
 *   and so `deliveryHolidaysOf` and `resolveAccess` read the same document.
 * @param {string} userId  whose home this is. Every reach question below is
 *   asked about THIS person, never about the caller — which is what will let
 *   phase 4's admin "preview as" endpoint reuse this function unchanged.
 * @param {Object}  args
 * @param {Object}  args.profile  the already-resolved profile. Passed in rather
 *   than loaded so there is exactly one read of the document per request.
 * @param {Date}   [args.now]     the instant the whole page is composed against.
 *   One clock for every section, so a page cannot straddle midnight and report
 *   two different months; injectable so the tests can pin one.
 * @returns {Promise<{sections: Object[]}>}
 */
const compose = async (org, userId, { profile, now = new Date() } = {}) => {
  const sections = Array.isArray(profile?.home) ? [...profile.home] : [];
  if (sections.length === 0) return { sections: [] };

  // Dense or not, `order` is what the person dragged. The array index is the
  // tiebreaker so two sections claiming one slot keep the order they were
  // stored in instead of swapping between requests.
  const ordered = sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) =>
      finiteOr(a.section.order, a.index) - finiteOr(b.section.order, b.index)
      || a.index - b.index);

  const boardsById = await loadBoardsById(org?._id, boardIdsNamedBy(sections, profile));

  /** Is this board one this person may read? Used by the many-board types. */
  const readable = (id) => {
    const board = boardsById.get(id);
    if (!board) return null;
    return resolveAccess(board, org, userId).canRead ? board : null;
  };

  /**
   * One section, gated and run. NEVER throws: the whole point of composing a
   * page out of independent parts is that a broken part is a broken part.
   */
  const composeOne = async ({ section, index }) => {
    const entry = HANDLERS[section.type];
    // A type that is no longer registered. `validateShape` refuses unknown types
    // on the way in, so this is a type that was REMOVED after somebody stored it
    // — a deploy, not a bad request — and it must degrade rather than throw.
    if (!entry) return envelope(section, index, unavailable(MESSAGES.UNKNOWN_TYPE));

    const config = CONFIG_NORMALISERS[section.type](section.config || {});

    let board = null;
    if (entry.boardKey) {
      const gated = gateBoard(entry, config, boardsById, org, userId);
      if (gated.error) return envelope(section, index, unavailable(gated.error));
      board = gated.board;
    }

    try {
      const result = await entry.run({
        org, userId, board, config, profile, now, readable,
      });
      return envelope(section, index, result);
    } catch (err) {
      // The real error goes to the log, where it can be fixed. The page gets a
      // sentence, because a stack trace on somebody's home page tells them
      // nothing and tells anyone reading over their shoulder too much.
      console.error(`executiveHome: section "${section.type}" failed:`, err);
      return envelope(section, index, unavailable(MESSAGES.FAILED));
    }
  };

  // In parallel. Every section is independent by construction (they share the
  // board batch and nothing else), and the cost of this endpoint is round trips
  // to a hosted cluster rather than CPU — the same reasoning
  // `fetchDeliveryInputs` and `getScoreboard` batch on. Sequential awaits would
  // make the front door of the app as slow as the sum of its tiles.
  return { sections: await Promise.all(ordered.map(composeOne)) };
};

module.exports = {
  compose,
  // Moved here from `services/executiveView.js`, which now re-exports
  // SECTION_TYPES from this file. A handler and the shape of the config it reads
  // are one decision; see the header.
  SECTION_TYPES,
  CONFIG_NORMALISERS,
  // Exported so a test can assert the registry and the config table name the
  // same types in both directions. That assertion is what keeps "adding a type
  // is a handler plus a renderer, and nothing else" true.
  HANDLERS,
  MESSAGES,
  // The mirror of the client's closed widget table. Exported so a test can
  // assert it is still the five — a mirror with no test is a list that drifts.
  REPORT_WIDGET_TYPES,
  MAX_MY_WORK,
  MAX_NOTE_TITLE,
  MAX_NOTE_TEXT,
};

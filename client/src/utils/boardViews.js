/**
 * WHICH VIEWS A BOARD OFFERS, AND WHICH ONE IT OPENS ON.
 *
 * A board's "view" is how the Board tab draws itself — a table, a stage board,
 * a ledger of documents. It is a different axis from `boardViewTabs.js`, which
 * decides which TABS a board has (Board / Chat / Delivery / Vault / …). One
 * board tab, several ways to draw it.
 *
 * ---- THE RULE THIS FILE EXISTS TO ENFORCE ---------------------------------
 *
 * Views ship one at a time, over several drops, while the templates that want
 * them are already in people's workspaces. So the registry names every view
 * that has been DESIGNED, and `BUILT` names the ones that actually render
 * today. A board asking for a view nobody has built yet gets the table — not a
 * blank pane, not a crash.
 *
 * That is what makes each new view additive: adding a key to `BUILT` is the
 * entire act of shipping one, and removing it is a complete rollback.
 *
 * ---- THE TASK BOARD IS SEALED ---------------------------------------------
 *
 * A board with no `templateKey` — which is every board that existed before
 * templates, and every Blank board made since — resolves to `['table']`. One
 * view means no switcher, so the ordinary task board renders exactly as it did
 * before this file existed. That is deliberate and load-bearing: it is the
 * promise that this whole feature is additive.
 *
 * No React and no JSX in here, so `boardViews.test.mjs` can assert the
 * behaviour in plain Node rather than describe it. Icons live at the render
 * site, the same way `boardViewTabs.js` keeps them out.
 */

/** The view every board can always draw. The floor, and the fallback. */
export const TABLE = 'table';

/**
 * What each template's board offers, best view first.
 *
 * Mirrors the `views` field on the server's template registry. Duplicated for
 * the same reason `boardTemplateDisplay.js` duplicates the naming: the board
 * page has to pick a view on FIRST PAINT, and asking the server which one would
 * mean every template board flashing the table before settling.
 */
const TEMPLATE_VIEWS = {
  billing: ['ledger', TABLE],
  budget: ['allocation', TABLE],
  pipeline: ['stages', TABLE],
  recruitment: ['stages', TABLE],
  expenses: ['queue', TABLE],
  content: ['calendar', TABLE],
};

/**
 * The views that actually render today.
 *
 * Everything in `TEMPLATE_VIEWS` is designed; only these are built. A view
 * named above and missing here is silently skipped, so a Billing board today
 * offers the table alone and starts offering the ledger the day `'ledger'` is
 * added to this set — with no other change anywhere.
 */
const BUILT = new Set([TABLE, 'stages', 'ledger']);

/** What the switcher calls each one. */
export const VIEW_LABELS = {
  [TABLE]: 'Table',
  stages: 'Stages',
  ledger: 'Ledger',
  allocation: 'Allocation',
  queue: 'Queue',
  calendar: 'Calendar',
};

/**
 * The views this board can show, in the order the switcher lists them.
 *
 * Always contains `table`, and always contains it LAST unless the template
 * explicitly puts it first — the table is the fallback, so it can never be
 * filtered out of its own safety net.
 *
 * @param {Object|null} board
 * @returns {string[]} at least `['table']`
 */
export const boardViews = (board) => {
  const wanted = TEMPLATE_VIEWS[board?.templateKey] || [TABLE];
  const built = wanted.filter((v) => BUILT.has(v));
  return built.includes(TABLE) ? built : [...built, TABLE];
};

/**
 * Which view to draw, validated against what this board can actually show.
 *
 * Order of preference: what the URL asks for, then the board's stored default,
 * then the table. Every step is checked against `boardViews`, so a stale link
 * (`?boardView=ledger` from before a rollback) and a board whose `defaultView`
 * names an unbuilt view both land on the table rather than on nothing.
 *
 * @param {string|null|undefined} raw   the `?boardView=` value
 * @param {Object|null} board
 * @returns {string}
 */
export const resolveBoardView = (raw, board) => {
  const available = boardViews(board);
  if (available.includes(raw)) return raw;
  const preferred = board?.defaultView;
  return available.includes(preferred) ? preferred : TABLE;
};

/** Does this board have anything to switch between? */
export const hasViewChoice = (board) => boardViews(board).length > 1;

export { TEMPLATE_VIEWS, BUILT };

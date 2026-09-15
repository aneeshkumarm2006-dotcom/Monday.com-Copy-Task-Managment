import { isMonthKey } from '../../utils/monthKeys';
import { buildMyWorkLink } from '../../utils/myWorkFilters';

/**
 * sectionLinks — the ONE place that knows how to leave a composed home section.
 *
 * Eight renderers in `sections/` each draw one kind of number, and every one of
 * them needs the same thing at the end: a way to the screen the number really
 * lives on. Built per file that is eight chances to forget the month, eight
 * spellings of `?view=`, and eventually two renderers that disagree about which
 * tab a delivery section belongs to. Built here it is a table.
 *
 * ---- WHY THIS IS A `.js` FILE AND NOT PART OF `SectionFrame.jsx` ----------
 *
 * The frame is where these are USED, and they started there. They moved because
 * a component file in this repo exports components and nothing else — Fast
 * Refresh cannot tell a changed helper from a changed component and remounts
 * the tree either way, which is why `react-refresh/only-export-components` is
 * clean across `src/components` apart from one harness. A helper beside a
 * component is also the thing every other module then has to import THROUGH the
 * component, which is how a plain function ends up dragging JSX into a test.
 *
 * ---- WHY NOT ON THE REGISTRY ---------------------------------------------
 *
 * `sectionRegistry.js` already holds one per-type table and this is a second,
 * so it looks like the natural home. It cannot be: the registry imports the
 * renderers, the renderers import their links, and putting the links there
 * closes a cycle between the two for no gain. The registry describes a section
 * to a PERSON choosing one; this describes it to a router.
 */

/**
 * `?view=` value per section type, for the four types that are about one
 * board's tab.
 *
 * The values are `VIEW_TABS` keys from `client/src/utils/boardViewTabs.js` and
 * the same strings the server validates a profile's `defaultTab` against. A
 * type absent from this table does not link to a board — either because it
 * names many (`boardTiles`) or none (`myWork`, `note`).
 *
 * ---- `reportWidget` LANDS ON THE TAB, NOT ON THE REPORT SCREEN ------------
 *
 * `seo` is the tab a connector earns by declaring dashboard screens, and the
 * Report is one of those screens. WHICH screen is showing is component state
 * inside `SeoDashboardTab`, not a query parameter, and that is a decision that
 * file makes on purpose and states in its own words: a reading position is not
 * the thing worth pasting to a colleague, and putting it in the URL would mean a
 * history entry per click. So this link opens the tab and the person picks
 * Report, which is one click and an honest one — inventing a `?screen=` here
 * would be a parameter nothing reads, which is a dead link wearing a hat.
 *
 * NO MONTH, and that is not an omission. The three tabs above are
 * month-partitioned and a link without a month lands on rows that are genuinely
 * not loaded (see below). A connector report is a rolling series over the last
 * ninety days with no month picker to disagree with, so `?month=` would mean
 * nothing there — and `boardViewLink` drops it anyway, because a `reportWidget`
 * config carries no month to pass.
 */
const BOARD_TAB_BY_TYPE = {
  goalScores: 'goals',
  deliveryScores: 'delivery',
  adsBudgetPacing: 'adsbudget',
  reportWidget: 'seo',
};

/**
 * The in-app path to one board's tab, optionally pinned to a month.
 *
 * ---- WHY THE MONTH IS NOT OPTIONAL IN PRACTICE -----------------------------
 *
 * A tracker board loads ONE MONTH AT A TIME. Every goal row, every delivery
 * cell and every budget line on it belongs to a `monthKey`, and the board picks
 * one on arrival (`?month=`, else the remembered one, else its current month).
 * So a link from an August tile that carries no month lands on a September
 * board, and the rows the person just clicked are not hidden or filtered — they
 * are genuinely not loaded. The page is not wrong, it is a different page, and
 * the only clue is a month picker they were not looking at.
 *
 * `utils/taskLink.js` states this for task deep links and solves it the same
 * way, with the same `month` parameter, which is why this builds that parameter
 * rather than a private one. Same shape, same reader — `BoardDetailPage` merges
 * `?month=` into the query it already has rather than replacing it.
 *
 * @param {string|Object} boardId  an id, or anything carrying `_id`
 * @param {Object} [opts]
 * @param {string|null} [opts.tab]   a `?view=` value; omitted lands on Board
 * @param {string|null} [opts.month] 'YYYY-MM'; anything else is dropped
 * @returns {string|null} an in-app path, or null when there is no board
 */
export const boardViewLink = (boardId, { tab = null, month = null } = {}) => {
  // The composer hands back ids as strings, but a caller holding a populated
  // board would pass an object. `String(x?._id || x)` is the house idiom for
  // exactly that; `.toString()` on a populated document is its inspect string,
  // never the hex id.
  const id = String(boardId?._id || boardId || '');
  if (!id) return null;

  const params = new URLSearchParams();
  if (tab) params.set('view', tab);
  // Validated rather than trusted: a malformed key would put the board into a
  // month that does not exist instead of simply being ignored.
  if (isMonthKey(month)) params.set('month', month);

  const query = params.toString();
  return query ? `/boards/${id}?${query}` : `/boards/${id}`;
};

/**
 * Where a composed section's "open it properly" link goes, or null when it has
 * none.
 *
 * FOUR RULES, all of them deliberate:
 *
 *  1. Nothing in the `unavailable` state gets a link. That state usually means
 *     the board left this person's reach, and offering somebody a link to a
 *     board they were just told they cannot open is worse than offering them
 *     nothing — it invites a click that ends on a permission error. The same
 *     holds for the analytics case, where the state means their role lost
 *     `analytics.view` and `/analytics` would refuse them too.
 *  2. The month comes off `data` FIRST and `config` second. `config.month` is
 *     `null` for the common "the board's current month" case, and the server
 *     resolved it into `data.monthKey` in the BOARD's timezone — which the
 *     browser has no way to work out for itself (`utils/monthKeys.js` says so,
 *     and refuses to try).
 *  3. `boardTiles` has no section link. Its tiles each link to their OWN board
 *     and their own default tab, so one link in the header would have to pick a
 *     favourite.
 *  4. `note` has no link. There is nowhere to go; it is text somebody typed.
 *  5. A NARROWED `workspaceNumbers` tile does not link to `/analytics`. See the
 *     branch itself — a link whose destination reports different totals from
 *     the tile that offered it is worse than no link.
 *
 * @param {Object} section - a composed section envelope
 * @returns {{to: string, label: string}|null}
 */
export const openLinkFor = (section) => {
  if (!section || section.state === 'unavailable') return null;

  const config = section.config || {};
  const data = section.data || {};

  const tab = BOARD_TAB_BY_TYPE[section.type];
  if (tab) {
    const to = boardViewLink(data.boardId || config.board, {
      tab,
      month: data.monthKey || config.month,
    });
    return to ? { to, label: 'Open board' } : null;
  }

  if (section.type === 'workspaceNumbers') {
    /**
     * THE NARROWED CASE GOES TO THE BOARD, NOT TO `/analytics`.
     *
     * `config.board` turns this tile into ONE BOARD's figures. `/analytics`
     * opens on "All Boards", so the destination would answer a different
     * question from the tile that sent the person there — 412 tasks on the
     * tile, 9,000 on the page it links to — and the two numbers carry the same
     * heading. That is not a stale link, it is two contradictory answers a
     * click apart.
     *
     * The narrowing cannot be carried in the URL today: `pages/AnalyticsPage.jsx`
     * holds its board filter and its range in component state seeded from
     * constants and reads NO query parameter at all (it does not even list
     * `90d`, which this section offers). Appending `?board=` would be a
     * parameter the page ignores — a filter that silently does nothing, which
     * is the same bug wearing a hat. The durable fix is for that page to read
     * `?board=` and `?range=` back the way My Work reads its own filters; until
     * it does, this points at the board whose numbers the tile is reporting,
     * which is where the tasks behind those four figures actually live.
     *
     * The WHOLE-WORKSPACE tile still goes to `/analytics`, which is the page
     * those figures come from. Its range can still differ from the section's
     * (the page defaults to 30 days) — but the page names its own range in a
     * picker at the top of it, so it states its scope rather than misstating
     * the tile's, and there is no truer destination for a workspace figure.
     */
    const boardId = data.boardId || config.board;
    if (boardId) {
      // No `?view=`: this section is not about a tab. No month either — these
      // are analytics over a rolling range, not a tracker board's month.
      const to = boardViewLink(boardId);
      if (to) return { to, label: 'Open board' };
    }
    return { to: '/analytics', label: 'Open analytics' };
  }

  if (section.type === 'myWork') {
    // `buildMyWorkLink` is the ONLY builder of a My Work deep link and the page
    // reads it back through `workFiltersFromParams`, so the due filter the tile
    // was showing survives the jump instead of dumping the person into an
    // unfiltered list of everything they own. 'all' is no filter at all, which
    // is an empty category and therefore an absent parameter.
    const due = config.due && config.due !== 'all' ? [config.due] : [];
    return { to: buildMyWorkLink({ due }), label: 'Open My Work' };
  }

  return null;
};

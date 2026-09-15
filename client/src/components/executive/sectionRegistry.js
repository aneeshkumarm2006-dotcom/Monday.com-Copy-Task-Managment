import {
  BarChart3,
  CalendarCheck,
  FileText,
  LayoutGrid,
  ListChecks,
  StickyNote,
  Target,
  Wallet,
} from 'lucide-react';

import AdsBudgetPacingSection from './sections/AdsBudgetPacingSection';
import BoardTilesSection from './sections/BoardTilesSection';
import DeliveryScoresSection from './sections/DeliveryScoresSection';
import GoalScoresSection from './sections/GoalScoresSection';
import MyWorkSection from './sections/MyWorkSection';
import NoteSection from './sections/NoteSection';
import ReportWidgetSection from './sections/ReportWidgetSection';
import WorkspaceNumbersSection from './sections/WorkspaceNumbersSection';

/**
 * sectionRegistry — the client half of `executiveHome.js`'s section registry.
 *
 * The server has `HANDLERS` (what a section type FETCHES) and
 * `CONFIG_NORMALISERS` (what its config may contain). This is the third leg:
 * what a section type LOOKS like, what it is CALLED when somebody is choosing
 * one, and what a brand new one starts out configured as.
 *
 * Two surfaces read it and neither should know the type keys otherwise:
 *
 *   the home page   looks a renderer up per composed envelope
 *   the editor      renders its "add a section" menu straight off this table
 *
 * Adding a section type is therefore: a row in `CONFIG_NORMALISERS`, an entry
 * in `HANDLERS`, a renderer in `sections/`, and a row here. Nothing else,
 * anywhere — no branch in the composer, none in the page, none in the editor.
 *
 * ---- WHY AN UNKNOWN TYPE MUST DEGRADE AND NOT THROW ----------------------
 *
 * `home[]` is stored data and this file is code that ships. The two are not
 * deployed together and never will be: a browser tab left open across a deploy
 * is running last week's bundle against this week's server, and a type REMOVED
 * from a build still exists in every profile that named it. `sectionFor` and
 * `sectionComponentFor` therefore answer `null` rather than throwing or
 * indexing into `undefined.component`, and the page skips what it cannot draw.
 *
 * The server does the mirror of this from the other side: a type it no longer
 * registers is composed as `state: 'unavailable'` with a sentence, rather than
 * being dropped, so the common case still produces a visible tile explaining
 * itself. Both halves degrade; neither takes the page down.
 *
 * ---- WHY THE LABELS DESCRIBE WHAT YOU GET, NOT WHAT IT IS ----------------
 *
 * These strings are what a person picks from in a menu. "goalScores" is a type
 * key and "Goal scores" is barely better — it names the machinery. The reason
 * anybody adds that section is to see how this month is going per client, so
 * that is what the description says. A menu of eight nouns from the data model
 * makes the chooser guess; a menu of eight sentences about what appears on the
 * page does not.
 *
 * ---- `defaultConfig` MIRRORS THE SERVER, DELIBERATELY --------------------
 *
 * Every default here is the value `CONFIG_NORMALISERS` in
 * `server/src/services/executiveHome.js` produces for an empty config, so a
 * section added in the editor and a section saved with `{}` are the same
 * section. Nothing can import across the two halves of the repo, so this is a
 * mirror rather than a shared constant — keep it in step by hand, and when in
 * doubt the SERVER is right, because it normalises on the way in and on the way
 * out and the client's copy only ever seeds a form.
 *
 * The same goes for the three limits and the two option lists below. They exist
 * so a config form can label and clamp its inputs the way the server will; they
 * are not a second validator, and a form that disagrees with them loses its
 * argument at the API boundary rather than storing something odd.
 */

/**
 * `defaultWidth` below is `'full'` or `'half'`, and both are statements about a
 * TWO-COLUMN grid. The grid itself is `SECTION_GRID_CLASS`, exported from
 * `SectionFrame.jsx` beside the `lg:col-span-2` it has to agree with.
 */

/** `myWork.limit` is clamped to 1..50 server-side, defaulting to 10. */
export const MY_WORK_LIMIT_MAX = 50;

/** A note is a reminder on a dashboard, not a document. */
export const NOTE_TITLE_MAX = 120;
export const NOTE_TEXT_MAX = 4000;

/**
 * `workspaceNumbers.range`, in the words the Analytics page uses for the three
 * it offers. `90d` is accepted by `analyticsReport.VALID_RANGES` and has no
 * control on that page; it is offered here because a section that can store it
 * should be able to set it.
 */
export const ANALYTICS_RANGE_OPTIONS = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

/**
 * `myWork.due`. The keys are the server's, and three of the four are also
 * `DUE_BUCKETS` keys in `utils/taskFilters.js` — which is what lets the
 * section's "Open My Work" link carry the same filter through to the page.
 */
export const MY_WORK_DUE_OPTIONS = [
  { value: 'all', label: 'Everything assigned to me' },
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'Due this week' },
  { value: 'overdue', label: 'Overdue' },
];

/**
 * type → { component, label, icon, description, defaultConfig, defaultWidth }.
 *
 * The ORDER is the order the "add a section" menu offers them, and it is the
 * order somebody builds a page in rather than the order the model lists: the
 * boards first, then the four per-board readings that are the reason this
 * feature exists, then the two workspace-wide lists, then the note.
 */
export const SECTION_REGISTRY = Object.freeze({
  boardTiles: {
    component: BoardTilesSection,
    icon: LayoutGrid,
    label: 'Board tiles',
    description: 'The boards on this view, as cards, in the order they are listed.',
    // Empty means EVERY board on the profile — not "no boards". The one place
    // in this feature where an empty list means all, and it is why the editor
    // must not "helpfully" prefill it.
    defaultConfig: { boards: [] },
    defaultWidth: 'full',
  },
  goalScores: {
    component: GoalScoresSection,
    icon: Target,
    label: 'Goal scores',
    description: 'How one board is tracking against this month’s goals, per client.',
    // `month: null` is "the board's current month", resolved server-side in the
    // BOARD's timezone on every compose. Storing a real month pins the section
    // to it forever, which is almost never what somebody means.
    defaultConfig: { board: null, month: null, groups: null },
    defaultWidth: 'full',
  },
  deliveryScores: {
    component: DeliveryScoresSection,
    icon: CalendarCheck,
    label: 'Delivery',
    description: 'Whether one board kept the commitments its trackers set this month.',
    defaultConfig: { board: null, month: null },
    defaultWidth: 'full',
  },
  adsBudgetPacing: {
    component: AdsBudgetPacingSection,
    icon: Wallet,
    label: 'Ads budget',
    description: 'Spend against budget on one board, and whether it is pacing.',
    defaultConfig: { board: null, month: null },
    defaultWidth: 'full',
  },
  reportWidget: {
    component: ReportWidgetSection,
    icon: FileText,
    label: 'Report widget',
    description: 'One figure or chart from a client’s SEO report, drawn exactly as the report draws it.',
    // Three nulls, and every one of them means "not configured yet" rather than
    // "everything". A report is built from ONE site's readings and a site is
    // mapped to a group, so a section with no group has no subject at all —
    // which is why, unlike `workspaceNumbers`' board, this one is required and
    // the server answers `unavailable` until it is set.
    defaultConfig: { board: null, group: null, widget: null },
    // A report widget is usually a KPI tile, which next to something wide reads
    // better than stretched across a screen. A line or a table is the case for
    // widening it, and that is one control away.
    defaultWidth: 'half',
  },
  workspaceNumbers: {
    component: WorkspaceNumbersSection,
    icon: BarChart3,
    label: 'Workspace numbers',
    description: 'Tasks, completion rate, overdue and active boards — the Analytics figures.',
    defaultConfig: { range: '30d', board: null },
    defaultWidth: 'full',
  },
  myWork: {
    component: MyWorkSection,
    icon: ListChecks,
    label: 'My work',
    description: 'The tasks assigned to the person reading the page, soonest first.',
    defaultConfig: { due: 'all', limit: 10 },
    // A list of one-line rows next to something wide reads better than a list
    // of one-line rows across a whole screen.
    defaultWidth: 'half',
  },
  note: {
    component: NoteSection,
    icon: StickyNote,
    label: 'Note',
    description: 'A short piece of text pinned to the page. No data behind it.',
    defaultConfig: { title: '', text: '' },
    defaultWidth: 'half',
  },
});

/**
 * The type keys this build can draw, in menu order.
 *
 * Derived from the table so the two cannot disagree — the same construction
 * `SECTION_TYPES` uses on the server, and for the same reason. It is a SUBSET
 * of the server's list by design whenever a deploy is mid-flight; it must never
 * be a superset, because a type here with no handler there composes to nothing.
 */
export const SECTION_TYPES = Object.freeze(Object.keys(SECTION_REGISTRY));

/**
 * The registry entry for a type, or `null` when this build has never heard of
 * it. See the header: stored data outlives the code that reads it.
 *
 * @param {string} type
 * @returns {Object|null}
 */
export const sectionFor = (type) =>
  (type && Object.prototype.hasOwnProperty.call(SECTION_REGISTRY, type)
    ? SECTION_REGISTRY[type]
    : null);

/**
 * The renderer for a type, or `null`.
 *
 * This is what the home page calls per composed envelope:
 *
 *   const Section = sectionComponentFor(section.type);
 *   return Section ? <Section key={section.id} section={section} /> : null;
 *
 * `hasOwnProperty` rather than a bare lookup, because a type of `'constructor'`
 * or `'toString'` off a stored document would otherwise return a function from
 * `Object.prototype` and React would try to render it.
 *
 * @param {string} type
 * @returns {Function|null}
 */
export const sectionComponentFor = (type) => sectionFor(type)?.component || null;

/**
 * Everything a section-picker needs, without the component: `{ type, label,
 * icon, description, defaultConfig, defaultWidth }` in menu order.
 *
 * Exported so the editor never has to iterate the registry itself and never has
 * to decide what an entry without a renderer means (there is no such entry —
 * that is what makes this table the menu).
 */
export const ADDABLE_SECTIONS = Object.freeze(
  SECTION_TYPES.map((type) => {
    // Named field by field rather than by spreading everything except
    // `component`: a future key added to an entry for the RENDERER's benefit
    // should not silently become part of the menu's contract.
    const entry = SECTION_REGISTRY[type];
    return Object.freeze({
      type,
      label: entry.label,
      icon: entry.icon,
      description: entry.description,
      defaultConfig: entry.defaultConfig,
      defaultWidth: entry.defaultWidth,
    });
  })
);

export default SECTION_REGISTRY;

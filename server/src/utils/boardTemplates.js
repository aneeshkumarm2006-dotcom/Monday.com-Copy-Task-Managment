/**
 * Board templates — what a new board starts with.
 *
 * ---- A TEMPLATE IS NOT A BOARD TYPE -------------------------------------
 *
 * `boardType` (standard / client / tracker) changes how a board BEHAVES: a
 * client board grows an external plane, a tracker board partitions itself by
 * month. Those are mutually exclusive and structural.
 *
 * A template only seeds CONTENT — columns, statuses, groups, a default view —
 * and then has no further existence. Nothing stores which template a board came
 * from, because after the first minute it is not true of the board in any
 * useful way: columns get added, statuses renamed, groups deleted.
 *
 * Keeping the two orthogonal is the whole reason this is cheap. A Billing board
 * can be private, client-facing or month-partitioned; if templates were types
 * we would owe seven × three combinations instead of seven entries.
 *
 * ---- ADDING ONE ---------------------------------------------------------
 *
 * One entry here and nothing else. The picker reads this list over the API, and
 * `createBoard` seeds from it. There is deliberately no second place to update.
 *
 * Every column `key` must be unique within its template, and exactly one column
 * carries `isPrimary: true` — it is the row title, and the board refuses to
 * delete it. `boardTemplates.test.js` enforces both, and the fact that every
 * type named here is a real one in columnTypes.js.
 */

const DEFAULT_STATUSES = [
  { key: 'not_started', name: 'Not Started', color: '#6B7280', order: 0, isDefault: true },
  { key: 'working_on_it', name: 'Working on it', color: '#D97706', order: 1, isDefault: false },
  { key: 'done', name: 'Done', color: '#16A34A', order: 2, isDefault: false },
  { key: 'stuck', name: 'Stuck', color: '#DC2626', order: 3, isDefault: false },
];

/** The twelve calendar months, for templates whose groups are months. */
const MONTH_GROUPS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** ₹ by default — the workspace this is being built for bills in rupees. */
const RUPEES = { format: 'currency', currency: 'INR', decimals: 0 };

const BOARD_TEMPLATES = [
  {
    key: 'blank',
    name: 'Blank',
    blurb: 'Tasks, status, owner, due date. What every board is today.',
    icon: 'layout',
    accent: '#6B7280',
    // No columns: a blank board keeps the legacy task shape, exactly as before
    // this feature existed. It is the default and must stay a no-op.
    columns: [],
    statuses: DEFAULT_STATUSES,
    groups: [],
    defaultView: 'table',
  },

  {
    key: 'billing',
    name: 'Billing & Invoices',
    blurb: 'One row per invoice. Groups are months; the footer totals what is owed.',
    icon: 'receipt',
    accent: '#16A34A',
    columns: [
      { key: 'invoice', name: 'Invoice', type: 'text', isPrimary: true, width: 130 },
      { key: 'client', name: 'Client', type: 'connect_boards', width: 190 },
      { key: 'amount', name: 'Amount', type: 'number', width: 130, settings: { ...RUPEES, summary: 'sum' } },
      { key: 'issued', name: 'Issued', type: 'date', width: 120 },
      { key: 'due', name: 'Due', type: 'date', width: 120 },
      { key: 'owner', name: 'Owner', type: 'person', width: 140 },
      { key: 'pdf', name: 'PDF', type: 'file', width: 110 },
      { key: 'notes', name: 'Notes', type: 'long_text', width: 200 },
    ],
    statuses: [
      { key: 'not_started', name: 'Draft', color: '#6B7280', order: 0, isDefault: true },
      { key: 'working_on_it', name: 'Sent', color: '#D97706', order: 1, isDefault: false },
      { key: 'done', name: 'Paid', color: '#16A34A', order: 2, isDefault: false },
      { key: 'stuck', name: 'Overdue', color: '#DC2626', order: 3, isDefault: false },
    ],
    groups: MONTH_GROUPS,
    defaultView: 'table',
  },

  {
    key: 'budget',
    name: 'Budget planner',
    blurb: 'Allocated against spent, with remaining and pacing worked out for you.',
    icon: 'chart',
    accent: '#2563EB',
    columns: [
      { key: 'category', name: 'Category', type: 'text', isPrimary: true, width: 200 },
      { key: 'allocated', name: 'Allocated', type: 'number', width: 140, settings: { ...RUPEES, summary: 'sum' } },
      { key: 'spent', name: 'Spent', type: 'number', width: 140, settings: { ...RUPEES, summary: 'sum' } },
      {
        key: 'remaining',
        name: 'Remaining',
        type: 'formula',
        width: 140,
        // Never typed, so it can never disagree with its two inputs.
        settings: { expression: 'column.allocated - column.spent', ...RUPEES, summary: 'sum' },
      },
      { key: 'owner', name: 'Owner', type: 'person', width: 140 },
      { key: 'notes', name: 'Notes', type: 'long_text', width: 200 },
    ],
    statuses: DEFAULT_STATUSES,
    groups: ['Paid media', 'Tools & software', 'Contractors', 'Other'],
    defaultView: 'table',
  },

  {
    key: 'pipeline',
    name: 'Sales pipeline',
    blurb: 'Groups are stages. Drag a deal from one to the next; the stage totals follow.',
    icon: 'users',
    accent: '#7C3AED',
    columns: [
      { key: 'company', name: 'Company', type: 'text', isPrimary: true, width: 190 },
      { key: 'contact', name: 'Contact', type: 'text', width: 160 },
      { key: 'email', name: 'Email', type: 'email', width: 190 },
      { key: 'phone', name: 'Phone', type: 'phone', width: 150 },
      { key: 'value', name: 'Deal value', type: 'number', width: 140, settings: { ...RUPEES, summary: 'sum' } },
      { key: 'closeDate', name: 'Close date', type: 'date', width: 130 },
      { key: 'owner', name: 'Owner', type: 'person', width: 140 },
      { key: 'nextStep', name: 'Next step', type: 'text', width: 180 },
    ],
    statuses: DEFAULT_STATUSES,
    // The stages ARE the groups — dragging a deal forward is the move the board
    // already does best, and it already writes to the activity log.
    groups: ['New lead', 'Qualified', 'Proposal sent', 'In negotiation', 'Won', 'Lost'],
    defaultView: 'table',
  },

  {
    key: 'recruitment',
    name: 'Recruitment',
    blurb: "Candidates through stages, with the CV and the interviewer's score on the row.",
    icon: 'hiring',
    accent: '#EA580C',
    columns: [
      { key: 'candidate', name: 'Candidate', type: 'text', isPrimary: true, width: 190 },
      { key: 'role', name: 'Role', type: 'dropdown', width: 180, settings: { options: [] } },
      { key: 'email', name: 'Email', type: 'email', width: 190 },
      { key: 'phone', name: 'Phone', type: 'phone', width: 150 },
      { key: 'cv', name: 'CV', type: 'file', width: 110 },
      { key: 'rating', name: 'Rating', type: 'rating', width: 130, settings: { max: 5, summary: 'avg' } },
      { key: 'interviewer', name: 'Interviewer', type: 'person', width: 150 },
      { key: 'nextRound', name: 'Next round', type: 'date', width: 130 },
      { key: 'notes', name: 'Notes', type: 'long_text', width: 200 },
    ],
    statuses: DEFAULT_STATUSES,
    groups: ['Applied', 'Screening', 'Interviewing', 'Offer out', 'Hired', 'Rejected'],
    defaultView: 'table',
    /**
     * The one template that overrides visibility.
     *
     * A hiring board carries salary talk, rejection notes and people's phone
     * numbers. Landing public because somebody clicked through the dialog is
     * not a mistake you get to fix afterwards — by then it has been read.
     */
    forceVisibility: 'private',
  },

  {
    key: 'expenses',
    name: 'Expenses & reimbursements',
    blurb: 'Who spent what, the receipt, and whether it has been approved and paid back.',
    icon: 'card',
    accent: '#D97706',
    columns: [
      { key: 'what', name: 'What', type: 'text', isPrimary: true, width: 220 },
      { key: 'who', name: 'Who', type: 'person', width: 150 },
      { key: 'category', name: 'Category', type: 'dropdown', width: 150, settings: { options: [] } },
      { key: 'amount', name: 'Amount', type: 'number', width: 130, settings: { ...RUPEES, summary: 'sum' } },
      { key: 'spentOn', name: 'Date', type: 'date', width: 120 },
      { key: 'receipt', name: 'Receipt', type: 'file', width: 120, settings: { summary: 'empty' } },
      /**
       * TWO checkboxes rather than one status, and it is not an oversight.
       * Approved and reimbursed are different facts and one is routinely true
       * without the other — a single status forces somebody to lie in the gap,
       * which is exactly the gap people chase you about.
       */
      { key: 'approved', name: 'Approved', type: 'checkbox', width: 110, settings: { summary: 'checked' } },
      { key: 'paidBack', name: 'Paid back', type: 'checkbox', width: 110, settings: { summary: 'checked' } },
    ],
    statuses: DEFAULT_STATUSES,
    groups: ['Awaiting approval', 'Approved & paid', 'Rejected'],
    defaultView: 'table',
  },

  {
    key: 'content',
    name: 'Content calendar',
    blurb: 'A piece per row — channel, writer, publish date, live link.',
    icon: 'calendar',
    accent: '#DC2626',
    columns: [
      { key: 'piece', name: 'Piece', type: 'text', isPrimary: true, width: 240 },
      { key: 'channel', name: 'Channel', type: 'dropdown', width: 150, settings: { options: [] } },
      { key: 'publishDate', name: 'Publish', type: 'date', width: 130 },
      { key: 'writer', name: 'Writer', type: 'person', width: 150 },
      { key: 'brief', name: 'Brief', type: 'long_text', width: 220 },
      { key: 'link', name: 'Live link', type: 'link', width: 160 },
    ],
    statuses: [
      { key: 'not_started', name: 'Idea', color: '#6B7280', order: 0, isDefault: true },
      { key: 'working_on_it', name: 'Drafting', color: '#D97706', order: 1, isDefault: false },
      { key: 'done', name: 'Published', color: '#16A34A', order: 2, isDefault: false },
      { key: 'stuck', name: 'Blocked', color: '#DC2626', order: 3, isDefault: false },
    ],
    groups: MONTH_GROUPS,
    /**
     * TABLE, not calendar — and that is a shortfall, not a preference.
     *
     * The design for this template has it opening on a month grid, which is
     * the right answer: for a content calendar the calendar IS the board. But
     * the board page has no calendar TAB — `/calendar` is a separate app page
     * over all boards — so there is nothing for `defaultView: 'calendar'` to
     * open. `resolveView` would fall back to the board view and the template
     * would quietly not do the thing it says.
     *
     * So it says table until the tab exists. The `defaultView` machinery is
     * built and works; what is missing is the view itself, and the test below
     * refuses any template that names a view the board cannot render.
     */
    defaultView: 'table',
  },
];

const templateByKey = (key) => BOARD_TEMPLATES.find((t) => t.key === key) || null;

const isTemplateKey = (key) => BOARD_TEMPLATES.some((t) => t.key === key);

/**
 * The list the picker renders. Columns are reduced to their names and types —
 * the picker shows what you will get, and shipping the full settings would put
 * formula expressions and currency config on a screen nobody reads them on.
 */
const templateSummaries = () =>
  BOARD_TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    blurb: t.blurb,
    icon: t.icon,
    accent: t.accent,
    columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
    statuses: t.statuses.map((s) => ({ name: s.name, color: s.color })),
    groups: t.groups,
    defaultView: t.defaultView,
    forceVisibility: t.forceVisibility || null,
  }));

module.exports = {
  BOARD_TEMPLATES,
  DEFAULT_STATUSES,
  templateByKey,
  isTemplateKey,
  templateSummaries,
};

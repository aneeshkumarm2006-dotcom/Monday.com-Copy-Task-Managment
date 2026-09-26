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
 * and then has no further existence. The board remembers which template it came
 * from only as a LABEL (`Board.templateKey`: the pill, the row noun, the filter
 * row), never as something to re-seed from, because after the first minute the
 * shape is not the template's any more: columns get added, statuses renamed,
 * groups deleted.
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
 *
 * ---- ROLES --------------------------------------------------------------
 *
 * `settings.role` marks the column that MEANS "due date" (`dueDate`) or "owner"
 * (`assignee`) on this board — Billing's `due`, Pipeline's `closeDate`. The
 * filters, My Work and the ledger's overdue rule read the role, never the key,
 * because keys differ per template and a user may rename anything. The resolver
 * is `utils/columnRoles.js`; it also falls back to the role named HERE for a
 * board whose columns predate the setting, which is why a role, once shipped on
 * a template column, must not move to a different key.
 */

const { normaliseCurrencyCode } = require('./money');

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

/**
 * Settings for a money column. The currency here is a PLACEHOLDER: every one
 * is re-stamped at creation with the board's currency (`seedTemplateColumns`),
 * so no board is ever born in it by accident. It stays a real code only so the
 * registry is valid data on its own.
 *
 * No `decimals`. This used to pin `decimals: 0`, which rendered an invoice for
 * 1,234.50 as 1,235 — a figure nobody billed. Left unset, the client renders
 * whole amounts without decimals and fractional ones with two.
 */
const MONEY = { format: 'currency', currency: 'INR' };

/**
 * The revision of the SHAPES in this file. `createBoard` stamps it onto every
 * board seeded from a built-in template (`Board.templateRevision`), and
 * scripts/upgradeTemplateBoards.js brings older boards up to it and then stamps
 * them too — so a re-run skips a board that is already current, and never puts
 * back a column its owner has since deleted.
 *
 *   0 — anything created before the field existed.
 *   1 — column roles (billing `due`/`owner`, …), billing's Payments column,
 *       no `decimals: 0` on money columns.
 *   2 — billing's Client column is a `client` column (a pick among the
 *       workspace's client boards), not an unfillable `connect_boards` one.
 *
 * Bump it with every change here that an EXISTING board should be upgraded to,
 * and teach the upgrade script the step in the same change.
 */
const TEMPLATE_REVISION = 2;

const BOARD_TEMPLATES = [
  {
    key: 'blank',
    name: 'Blank',
    blurb: 'Tasks, status, owner, due date. What every board is today.',
    /** What one row IS. The group header reads "5 items", not
     *  "5 items" — a board that calls its invoices items is a board that has not
     *  been set up for the work. */
    rowNoun: ['item', 'items'],
    /** The label on the board's primary button. */
    rowAction: 'task',
    /** Which filters the board offers. Priority and Labels are meaningless on
     *  an invoice, and a filter that never narrows anything is a control that
     *  teaches people the row of controls is not worth reading. */
    filters: ['status','priority','labels','due','owner'],
    icon: 'layout',
    accent: '#6B7280',
    // No columns: a blank board keeps the legacy task shape, exactly as before
    // this feature existed. It is the default and must stay a no-op.
    columns: [],
    statuses: DEFAULT_STATUSES,
    groups: [],
    /**
     * Which of `views` this board opens on. Always the first — the view the
     * template was designed for. If it is not built yet the client's
     * `boardViews.js` draws the table instead, so this can name the intent
     * before the code exists.
     */
    views: ['table'],
    defaultView: 'table',
  },

  {
    key: 'billing',
    name: 'Billing & Invoices',
    // It used to promise "Groups are months" while seeding one group — see
    // `groups` below for why there are no month groups. The month an invoice
    // belongs to comes from its Issued date.
    blurb: 'One row per invoice. Its month comes from the Issued date, and every payment against it is recorded on the row.',
    /** What one row IS. The group header reads "5 invoices", not
     *  "5 items" — a board that calls its invoices items is a board that has not
     *  been set up for the work. */
    rowNoun: ['invoice', 'invoices'],
    /** The label on the board's primary button. */
    rowAction: 'invoice',
    /** Which filters the board offers. Priority and Labels are meaningless on
     *  an invoice, and a filter that never narrows anything is a control that
     *  teaches people the row of controls is not worth reading. */
    filters: ['status','due','owner'],
    icon: 'receipt',
    accent: '#16A34A',
    columns: [
      { key: 'invoice', name: 'Invoice', type: 'text', isPrimary: true, width: 130 },
      /**
       * SECOND, not seventh. The document is the thing that exists first — you
       * have the PDF before you have the number typed, the client linked or the
       * amount agreed — so it sits beside the number that names it rather than
       * off the right-hand edge of the scroll.
       *
       * `dropColumn` on this template points here: a PDF dropped on the board
       * lands in this column and becomes a row.
       */
      { key: 'pdf', name: 'PDF', type: 'file', width: 130 },
      /**
       * WHO the invoice is for: one of the workspace's client boards (a client
       * board IS one client), or a name typed in for a client that has no
       * board. A `client` column, not `connect_boards` — a connect column
       * needs target boards and a ROW on them, which is why this one could
       * never be filled: there is no row on a client board that is "the
       * client". See the `client` entry in utils/columnTypes.js.
       */
      { key: 'client', name: 'Client', type: 'client', width: 190 },
      { key: 'amount', name: 'Amount', type: 'number', width: 130, settings: { ...MONEY, summary: 'sum' } },
      /**
       * What has actually come in, as a list — an invoice paid in three
       * instalments is three entries with their own dates, not one number
       * overwritten three times. Right after Amount because the two are read
       * together: billed, then received. Its total is what "outstanding" is
       * worked out against.
       */
      { key: 'payments', name: 'Payments', type: 'payments', width: 150, settings: { ...MONEY, summary: 'sum' } },
      { key: 'issued', name: 'Issued', type: 'date', width: 120 },
      { key: 'due', name: 'Due', type: 'date', width: 120, settings: { role: 'dueDate' } },
      { key: 'owner', name: 'Owner', type: 'person', width: 140, settings: { role: 'assignee' } },
      // Notes dropped: every row already has an updates thread, and a long_text
      // column duplicating it only widened the horizontal scroll.
    ],
    statuses: [
      { key: 'not_started', name: 'Draft', color: '#6B7280', order: 0, isDefault: true },
      { key: 'working_on_it', name: 'Sent', color: '#D97706', order: 1, isDefault: false },
      { key: 'done', name: 'Paid', color: '#16A34A', order: 2, isDefault: false },
      { key: 'stuck', name: 'Overdue', color: '#DC2626', order: 3, isDefault: false },
    ],
    /**
     * ONE group, not twelve months.
     *
     * There is already an `issued` column, so the month an invoice belongs to
     * is DERIVED from it, not a separate fact. Asking someone to also file the
     * row into March creates a way for the board to disagree with itself — an
     * invoice issued on 2 April sitting in March forever because it was dropped
     * one row too high. A group is for something the data cannot tell you, and
     * a month is not that.
     *
     * Twelve empty months also meant a new billing board opened as twelve rows
     * of chrome above zero invoices.
     */
    groups: ['Invoices'],
    /**
     * Which column a file dropped on this board lands in. The ledger view reads
     * it to turn a dropped PDF into a row; a template without it accepts no
     * drops at all.
     */
    dropColumn: 'pdf',
    /**
     * Which of `views` this board opens on. Always the first — the view the
     * template was designed for. If it is not built yet the client's
     * `boardViews.js` draws the table instead, so this can name the intent
     * before the code exists.
     */
    views: ['ledger', 'table'],
    defaultView: 'ledger',
  },

  {
    key: 'budget',
    name: 'Budget planner',
    blurb: 'Allocated against spent, with remaining and pacing worked out for you.',
    /** What one row IS. The group header reads "5 lines", not
     *  "5 items" — a board that calls its invoices items is a board that has not
     *  been set up for the work. */
    rowNoun: ['line', 'lines'],
    /** The label on the board's primary button. */
    rowAction: 'line',
    /** Which filters the board offers. Priority and Labels are meaningless on
     *  an invoice, and a filter that never narrows anything is a control that
     *  teaches people the row of controls is not worth reading. */
    filters: ['owner'],
    icon: 'chart',
    accent: '#2563EB',
    columns: [
      { key: 'category', name: 'Category', type: 'text', isPrimary: true, width: 200 },
      { key: 'allocated', name: 'Allocated', type: 'number', width: 140, settings: { ...MONEY, summary: 'sum' } },
      { key: 'spent', name: 'Spent', type: 'number', width: 140, settings: { ...MONEY, summary: 'sum' } },
      {
        key: 'remaining',
        name: 'Remaining',
        type: 'formula',
        width: 140,
        // Never typed, so it can never disagree with its two inputs.
        settings: { expression: 'column.allocated - column.spent', ...MONEY, summary: 'sum' },
      },
      /**
       * The ASSIGNEE, like every other template's person column. Without the
       * role nothing synced the cell onto `assignedTo`, so the board's only
       * filter (Owner) and My Work never saw a line's owner, and a contributor
       * had no way to claim a line once the panel showed the column fields.
       */
      { key: 'owner', name: 'Owner', type: 'person', width: 140, settings: { role: 'assignee' } },
      { key: 'notes', name: 'Notes', type: 'long_text', width: 200 },
    ],
    statuses: DEFAULT_STATUSES,
    groups: ['Paid media', 'Tools & software', 'Contractors', 'Other'],
    /**
     * Which of `views` this board opens on. Always the first — the view the
     * template was designed for. If it is not built yet the client's
     * `boardViews.js` draws the table instead, so this can name the intent
     * before the code exists.
     */
    views: ['allocation', 'table'],
    defaultView: 'allocation',
  },

  {
    key: 'pipeline',
    name: 'Sales pipeline',
    blurb: 'Groups are stages. Drag a deal from one to the next; the stage totals follow.',
    /** What one row IS. The group header reads "5 deals", not
     *  "5 items" — a board that calls its invoices items is a board that has not
     *  been set up for the work. */
    rowNoun: ['deal', 'deals'],
    /** The label on the board's primary button. */
    rowAction: 'deal',
    /** Which filters the board offers. Priority and Labels are meaningless on
     *  an invoice, and a filter that never narrows anything is a control that
     *  teaches people the row of controls is not worth reading. */
    filters: ['owner','due'],
    icon: 'users',
    accent: '#7C3AED',
    columns: [
      { key: 'company', name: 'Company', type: 'text', isPrimary: true, width: 190 },
      { key: 'contact', name: 'Contact', type: 'text', width: 160 },
      { key: 'email', name: 'Email', type: 'email', width: 190 },
      { key: 'phone', name: 'Phone', type: 'phone', width: 150 },
      { key: 'value', name: 'Deal value', type: 'number', width: 140, settings: { ...MONEY, summary: 'sum' } },
      { key: 'closeDate', name: 'Close date', type: 'date', width: 130, settings: { role: 'dueDate' } },
      { key: 'owner', name: 'Owner', type: 'person', width: 140, settings: { role: 'assignee' } },
      { key: 'nextStep', name: 'Next step', type: 'text', width: 180 },
    ],
    statuses: DEFAULT_STATUSES,
    // The stages ARE the groups — dragging a deal forward is the move the board
    // already does best, and it already writes to the activity log.
    groups: ['New lead', 'Qualified', 'Proposal sent', 'In negotiation', 'Won', 'Lost'],
    /**
     * Which of `views` this board opens on. Always the first — the view the
     * template was designed for. If it is not built yet the client's
     * `boardViews.js` draws the table instead, so this can name the intent
     * before the code exists.
     */
    views: ['stages', 'table'],
    defaultView: 'stages',
  },

  {
    key: 'recruitment',
    name: 'Recruitment',
    blurb: "Candidates through stages, with the CV and the interviewer's score on the row.",
    /** What one row IS. The group header reads "5 candidates", not
     *  "5 items" — a board that calls its invoices items is a board that has not
     *  been set up for the work. */
    rowNoun: ['candidate', 'candidates'],
    /** The label on the board's primary button. */
    rowAction: 'candidate',
    /** Which filters the board offers. Priority and Labels are meaningless on
     *  an invoice, and a filter that never narrows anything is a control that
     *  teaches people the row of controls is not worth reading. */
    filters: ['status','owner'],
    icon: 'hiring',
    accent: '#EA580C',
    columns: [
      { key: 'candidate', name: 'Candidate', type: 'text', isPrimary: true, width: 190 },
      { key: 'role', name: 'Role', type: 'dropdown', width: 180, settings: { options: [] } },
      { key: 'email', name: 'Email', type: 'email', width: 190 },
      { key: 'phone', name: 'Phone', type: 'phone', width: 150 },
      { key: 'cv', name: 'CV', type: 'file', width: 110 },
      { key: 'rating', name: 'Rating', type: 'rating', width: 130, settings: { max: 5, summary: 'avg' } },
      { key: 'interviewer', name: 'Interviewer', type: 'person', width: 150, settings: { role: 'assignee' } },
      { key: 'nextRound', name: 'Next round', type: 'date', width: 130, settings: { role: 'dueDate' } },
      { key: 'notes', name: 'Notes', type: 'long_text', width: 200 },
    ],
    statuses: DEFAULT_STATUSES,
    groups: ['Applied', 'Screening', 'Interviewing', 'Offer out', 'Hired', 'Rejected'],
    // Drop a CV on the board and it becomes a candidate. See `dropColumn` on
    // billing; only the ledger reads this today.
    dropColumn: 'cv',
    /**
     * Which of `views` this board opens on. Always the first — the view the
     * template was designed for. If it is not built yet the client's
     * `boardViews.js` draws the table instead, so this can name the intent
     * before the code exists.
     */
    views: ['stages', 'table'],
    defaultView: 'stages',
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
    /** What one row IS. The group header reads "5 claims", not
     *  "5 items" — a board that calls its invoices items is a board that has not
     *  been set up for the work. */
    rowNoun: ['claim', 'claims'],
    /** The label on the board's primary button. */
    rowAction: 'claim',
    /** Which filters the board offers. Priority and Labels are meaningless on
     *  an invoice, and a filter that never narrows anything is a control that
     *  teaches people the row of controls is not worth reading. */
    // No 'due': no column here plays the due-date role (`spentOn` is when the
    // money went out, not a deadline — giving it the role would make every
    // claim an invoice that can be late), so a Due filter would only ever say
    // "No due date".
    filters: ['status','owner'],
    icon: 'card',
    accent: '#D97706',
    columns: [
      { key: 'what', name: 'What', type: 'text', isPrimary: true, width: 220 },
      { key: 'who', name: 'Who', type: 'person', width: 150, settings: { role: 'assignee' } },
      { key: 'category', name: 'Category', type: 'dropdown', width: 150, settings: { options: [] } },
      { key: 'amount', name: 'Amount', type: 'number', width: 130, settings: { ...MONEY, summary: 'sum' } },
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
    // Photograph the receipt, drop it, the claim exists.
    dropColumn: 'receipt',
    /**
     * Which of `views` this board opens on. Always the first — the view the
     * template was designed for. If it is not built yet the client's
     * `boardViews.js` draws the table instead, so this can name the intent
     * before the code exists.
     */
    views: ['queue', 'table'],
    defaultView: 'queue',
  },

  {
    key: 'content',
    name: 'Content calendar',
    blurb: 'A piece per row — channel, writer, publish date, live link.',
    /** What one row IS. The group header reads "5 pieces", not
     *  "5 items" — a board that calls its invoices items is a board that has not
     *  been set up for the work. */
    rowNoun: ['piece', 'pieces'],
    /** The label on the board's primary button. */
    rowAction: 'piece',
    /** Which filters the board offers. Priority and Labels are meaningless on
     *  an invoice, and a filter that never narrows anything is a control that
     *  teaches people the row of controls is not worth reading. */
    filters: ['status','due','owner'],
    icon: 'calendar',
    accent: '#DC2626',
    columns: [
      { key: 'piece', name: 'Piece', type: 'text', isPrimary: true, width: 240 },
      { key: 'channel', name: 'Channel', type: 'dropdown', width: 150, settings: { options: [] } },
      { key: 'publishDate', name: 'Publish', type: 'date', width: 130, settings: { role: 'dueDate' } },
      { key: 'writer', name: 'Writer', type: 'person', width: 150, settings: { role: 'assignee' } },
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
     * Which of `views` this board opens on. Always the first — the view the
     * template was designed for. If it is not built yet the client's
     * `boardViews.js` draws the table instead, so this can name the intent
     * before the code exists.
     */
    views: ['calendar', 'table'],
    defaultView: 'calendar',
  },
];

const templateByKey = (key) => BOARD_TEMPLATES.find((t) => t.key === key) || null;

const isTemplateKey = (key) => BOARD_TEMPLATES.some((t) => t.key === key);

/**
 * The columns a new board is born with, from a template or from another board.
 *
 * THE one implementation — `createBoard` calls it and `boardTemplateSeed.test.js`
 * calls it, so the test asserts what the controller actually does rather than a
 * hand-written copy of it that could drift.
 *
 * ---- Currency ------------------------------------------------------------
 *
 * A built-in template's money columns carry a placeholder (`MONEY`), so every
 * one is re-stamped with `currency` — the board's own unit.
 *
 * A COPY (`fromBoard`) is different: its columns are a real board's, with
 * currencies somebody chose. Re-stamping those is how copying a CAD board into
 * an INR workspace produced a board whose every amount read as rupees. So a
 * copied column keeps its own code, and only one whose code is missing or not
 * one we carry takes `currency`.
 *
 * `order` is the array position, because that is the order the template (or
 * the source board, already sorted) was designed in.
 *
 * @param {{ columns: Array }} tpl
 * @param {{ currency?: string|null, fromBoard?: boolean }} [opts]
 */
const seedTemplateColumns = (tpl, { currency = null, fromBoard = false } = {}) =>
  (tpl && Array.isArray(tpl.columns) ? tpl.columns : []).map((c, i) => {
    // A template's settings are shared constants (and hold arrays), so they
    // are copied deeply — a board must never share an object with the
    // registry. A copied board's may hold ObjectIds, which a JSON round-trip
    // would flatten, so those are copied one level down, which is all the
    // seed ever writes to.
    const source = c.settings || {};
    const settings = fromBoard ? { ...source } : JSON.parse(JSON.stringify(source));
    if (settings.format === 'currency') {
      // A copied column's own code is read the way every other money reader
      // reads it — trimmed and upper-cased — so a board written before codes
      // were stored normalised ('cad', ' CAD ') copies as the CAD it renders
      // as, not as "not a code we carry" re-stamped into the new board's unit.
      // And the copy stores it normalised, so the client's exact-match lookup
      // recognises it.
      const own = fromBoard ? normaliseCurrencyCode(settings.currency) : null;
      if (own) settings.currency = own;
      else if (currency) settings.currency = currency;
    }
    return { ...c, order: i, settings };
  });

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
    rowNoun: t.rowNoun,
    rowAction: t.rowAction,
    filters: t.filters,
    // Whether the create dialog should ask what currency the board is in —
    // derived from the columns, so a new money template is asked about
    // without anyone remembering to add its key to a list on the client.
    hasMoney: t.columns.some(
      (c) => c.type === 'payments' || (c.settings && c.settings.format === 'currency')
    ),
  }));

module.exports = {
  BOARD_TEMPLATES,
  TEMPLATE_REVISION,
  DEFAULT_STATUSES,
  templateByKey,
  isTemplateKey,
  templateSummaries,
  seedTemplateColumns,
};

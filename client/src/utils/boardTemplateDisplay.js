/**
 * What a template board CALLS things.
 *
 * A board seeded from Billing is a list of invoices, and every place that says
 * "0 items", offers a Priority filter, or puts "New Group" where "New invoice"
 * belongs is a board that has not been set up for the work. This is the one
 * place those words live.
 *
 * MIRRORS the display fields in server/src/utils/boardTemplates.js. Duplicated
 * rather than fetched: the board page renders these on first paint, and a
 * round-trip to learn what to call a row would mean every template board
 * flashing "items" before settling. The server's `boardTemplateDisplay.test.js`
 * is the tripwire that keeps the two in step.
 *
 * `templateKey` is a LABEL on the board and is never read to decide behaviour —
 * see the field's comment on the model. Everything here is naming.
 */

const TEMPLATE_DISPLAY = {
  billing: {
    label: 'Billing',
    color: '#16A34A',
    background: '#F0FDF4',
    rowNoun: ['invoice', 'invoices'],
    rowAction: 'invoice',
    filters: ['status', 'due', 'owner'],
  },
  budget: {
    label: 'Budget',
    color: '#1E40AF',
    background: '#EFF6FF',
    rowNoun: ['line', 'lines'],
    rowAction: 'line',
    filters: ['owner'],
  },
  pipeline: {
    label: 'Pipeline',
    color: '#7C3AED',
    background: '#F5F3FF',
    rowNoun: ['deal', 'deals'],
    rowAction: 'deal',
    filters: ['owner', 'due'],
  },
  recruitment: {
    label: 'Recruitment',
    color: '#EA580C',
    background: '#FFF7ED',
    rowNoun: ['candidate', 'candidates'],
    rowAction: 'candidate',
    filters: ['status', 'owner'],
  },
  expenses: {
    label: 'Expenses',
    color: '#D97706',
    background: '#FFFBEB',
    rowNoun: ['claim', 'claims'],
    rowAction: 'claim',
    filters: ['status', 'owner', 'due'],
  },
  content: {
    label: 'Content',
    color: '#DC2626',
    background: '#FEF2F2',
    rowNoun: ['piece', 'pieces'],
    rowAction: 'piece',
    filters: ['status', 'due', 'owner'],
  },
};

/** Everything a plain task board calls things. Also the fallback. */
const DEFAULT_DISPLAY = {
  label: null,
  color: null,
  background: null,
  rowNoun: ['item', 'items'],
  rowAction: 'task',
  filters: ['status', 'priority', 'labels', 'due', 'owner'],
};

/**
 * The display facts for a board.
 *
 * Falls back to the plain task-board wording for a board with no template, and
 * for one whose template has since been removed from the registry — a stored
 * key that no longer resolves must degrade to a working board, not to
 * `undefined` in a heading.
 */
export const templateDisplay = (board) =>
  TEMPLATE_DISPLAY[board?.templateKey] || DEFAULT_DISPLAY;

/** "5 invoices" / "1 invoice" / "0 invoices". */
export const rowCountLabel = (board, count) => {
  const [one, many] = templateDisplay(board).rowNoun;
  return `${count} ${count === 1 ? one : many}`;
};

/** "New invoice" for the board's primary button. */
export const newRowLabel = (board) => `New ${templateDisplay(board).rowAction}`;

/** Does this board offer that filter? */
export const boardOffersFilter = (board, key) =>
  templateDisplay(board).filters.includes(key);

export { TEMPLATE_DISPLAY, DEFAULT_DISPLAY };

/**
 * columnRoles.js — which column on a flexible-columns board MEANS "due date",
 * and which one means "owner".
 *
 * ---- WHY A ROLE, NOT A KEY ------------------------------------------------
 *
 * The task's legacy `dueDate` / `assignedTo` fields are what the rest of the
 * product reads: the board's Due and Owner filters, My Work, the due digest,
 * the calendar. On a flexible board the COLUMN is what people edit, so the two
 * have to be kept in step (see the pre-save hook in models/Task.js).
 *
 * That sync used to find its columns by slug — `due_date` and `assignees`,
 * the keys `migrateLegacyColumns` writes. No template uses those slugs: billing
 * calls its columns `due` and `owner`, pipeline `closeDate`, content
 * `publishDate` and `writer`. So on every template board the sync matched
 * nothing, and an invoice whose Due column said it was 24 days late was, to the
 * filters and to My Work, an invoice with no due date and no owner.
 *
 * Hardcoding the template slugs here would put trade vocabulary in code (see
 * the tracker-boards-stay-generic rule). A role is a fact the COLUMN carries
 * instead: `settings.role: 'dueDate' | 'assignee'`. Templates stamp it on the
 * columns that mean it, and nothing here knows what an invoice is.
 *
 * ---- RESOLUTION ORDER -----------------------------------------------------
 *
 *   0. `settings.role === 'none'` — the column EXPLICITLY plays no role, and
 *      nothing below may give it one (see "OPTING OUT");
 *   1. the column's own `settings.role` — always wins;
 *   2. the role of the same-key column in the template named by
 *      `board.templateKey` — so a board created BEFORE templates carried roles
 *      resolves the same as one created after, with no migration;
 *   3. the legacy migration slugs (`due_date`, `assignees`), which is exactly
 *      what the old key map did, so migrated boards keep syncing unchanged.
 *
 * The same order ranks COLUMNS against each other: when two columns both
 * claim a role, `roleColumn` takes the one with the stronger claim (own, then
 * template, then slug) before it falls back to array order.
 *
 * Step 2 is the one place `templateKey` informs behaviour. It only ever
 * SUPPLIES a role the column does not state for itself — it cannot override
 * one — and a board whose template has left the registry simply falls through
 * to step 3.
 *
 * ---- OPTING OUT ------------------------------------------------------------
 *
 * Steps 2 and 3 make a role something a column can have without ever having
 * been given one — which also made it something it could never be RID of.
 * Clearing Billing's `due` (deleting its `settings.role`) only handed it back
 * to the template, so "this is not the due date" was unsayable. `'none'` says
 * it: stored on the column, it stops the fallbacks for that column.
 *
 * Two writers produce it (controllers/columnController.js): a person who
 * explicitly un-marks a column, and `releaseRole`, which runs when another
 * column CLAIMS a role — a role is held by at most one column, and a column
 * that would otherwise keep it through its template is told `'none'` so it
 * does not. An empty role (`null` / `''`) is different: it deletes the key and
 * so means "back to the default", template and slug included.
 *
 * `client/src/utils/columnRoles.js` mirrors this. The two must resolve the same
 * column, or the panel would edit one date while the filters read another.
 */

const ROLES = ['dueDate', 'assignee'];

/** The column TYPE each role must have — a text column called "Due" is not a date. */
const ROLE_COLUMN_TYPE = {
  dueDate: 'date',
  assignee: 'person',
};

/** The slugs `migrateLegacyColumns` gives the columns it creates. */
const LEGACY_KEY_ROLES = {
  due_date: 'dueDate',
  assignees: 'assignee',
};

const isRole = (value) => typeof value === 'string' && ROLES.includes(value);

/**
 * The stored opt-out: "this column plays no role, whatever its template or its
 * slug would say". Not a role — `isRole('none')` is false — so nothing can ever
 * resolve a column BY it.
 */
const NO_ROLE = 'none';

/** The role a column states for itself, `NO_ROLE`, or null when it states nothing. */
const ownRoleOf = (col) => {
  const own = col && col.settings && typeof col.settings === 'object' ? col.settings.role : null;
  if (own === NO_ROLE) return NO_ROLE;
  return isRole(own) ? own : null;
};

/**
 * The role the template says a column with this key plays, or null.
 *
 * `boardTemplates` is required lazily, at call time: models/Task.js reaches
 * this module from a save hook, and a module-load dependency on the template
 * registry from the model layer is a cycle waiting to happen.
 */
const templateRoleFor = (board, key) => {
  if (!board || !board.templateKey || !key) return null;
  const { templateByKey } = require('./boardTemplates');
  const tpl = templateByKey(board.templateKey);
  if (!tpl || !Array.isArray(tpl.columns)) return null;
  const tcol = tpl.columns.find((c) => c && c.key === key);
  const role = tcol && tcol.settings ? tcol.settings.role : null;
  return isRole(role) ? role : null;
};

/**
 * The role `col` plays on `board`, or null. See the header for the order.
 * Does NOT check the column's type — `roleColumn` does, because a caller asking
 * "what does this column claim to be" and one asking "which column do I sync"
 * want different answers for a mistyped column.
 */
const columnRole = (board, col) => {
  if (!col) return null;
  const own = ownRoleOf(col);
  if (own === NO_ROLE) return null;
  if (own) return own;
  const fromTemplate = templateRoleFor(board, col.key);
  if (fromTemplate) return fromTemplate;
  return LEGACY_KEY_ROLES[col.key] || null;
};

/**
 * WHERE a column's role comes from: 1 = its own `settings.role`, 2 = its
 * template's, 3 = a legacy migration slug, or 0 when it plays no role —
 * including a column that opted out with `'none'`. The same steps as
 * `columnRole`, reported as a rank so `roleColumn` can prefer the strongest
 * claim across columns rather than within one.
 */
const roleRank = (board, col, role) => {
  if (!col) return 0;
  const own = ownRoleOf(col);
  if (own === NO_ROLE) return 0;
  if (own) return own === role ? 1 : 0;
  const fromTemplate = templateRoleFor(board, col.key);
  if (fromTemplate) return fromTemplate === role ? 2 : 0;
  return LEGACY_KEY_ROLES[col.key] === role ? 3 : 0;
};

/**
 * The column on `board` that plays `role` AND has the type that role needs, or
 * null.
 *
 * STRONGEST CLAIM FIRST, then array order. A column somebody explicitly marked
 * as the due date beats one that is only the due date because its template
 * said so, which beats one that is only the due date because of its slug.
 * Plain array order got that wrong the moment a board carried both: a
 * migrated board with a legacy `due_date` column to the LEFT of a new
 * "Deadline" column its owner had just marked as the due date kept syncing the
 * old one, so the setting visibly did nothing. Within one rank, array order —
 * so the answer is still stable across reads.
 *
 * `client/src/utils/columnRoles.js` resolves in the same order; the two must
 * pick the same column.
 */
const roleColumn = (board, role) => {
  const type = ROLE_COLUMN_TYPE[role];
  if (!type || !board || !Array.isArray(board.columns)) return null;
  let best = null;
  let bestRank = 0;
  for (const c of board.columns) {
    if (!c || c.type !== type) continue;
    const rank = roleRank(board, c, role);
    if (rank === 0) continue;
    if (bestRank === 0 || rank < bestRank) {
      best = c;
      bestRank = rank;
      if (rank === 1) break;
    }
  }
  return best;
};

module.exports = {
  ROLES,
  ROLE_COLUMN_TYPE,
  LEGACY_KEY_ROLES,
  NO_ROLE,
  isRole,
  columnRole,
  roleColumn,
};

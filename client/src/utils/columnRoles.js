/**
 * COLUMN ROLES — which column on a flexible board MEANS "due date" or "owner".
 *
 * A template board's dates and people live in ordinary columns with
 * trade-specific names: a pipeline's "Close date", a recruitment board's "Next
 * round", a content board's "Writer". Anything that wants to ask "when is this
 * row due" or "whose is it" — My Work, reminders, the calendar — needs to know
 * which of a board's date columns that is, and cannot guess by type (billing
 * has two date columns and only `due` is the one an invoice is late against)
 * or by name (names are the board owner's to change).
 *
 * So the role is a fact recorded on the column, `settings.role`, and resolved
 * in this order:
 *
 *   1. the column's own `settings.role`;
 *   2. else the role the SAME-KEY column carries in the template the board was
 *      made from (`board.templateKey`) — which covers every board created
 *      before roles were stamped, without a migration;
 *   3. else the legacy keys the pre-template boards used (`due_date`,
 *      `assignees`).
 *
 * The vocabulary stays in the TEMPLATE, never here as trade logic: this file
 * knows "billing's `due` is a due date" only because that is what the billing
 * template says, and a board of any other shape states its roles on its
 * columns.
 *
 * ---- `role: 'none'` — "this column plays no role", said on purpose -----------
 *
 * Steps 2 and 3 only ever SUPPLY a role a column does not state. That made a
 * template role impossible to take away: clearing it stored nothing, nothing
 * fell through to the template, and billing's `due` was the due date again on
 * the next read. `NO_ROLE` is the column stating, in its own words, that it has
 * no role — step 1 answering "none" — so neither the template nor a legacy key
 * gets a say. It is a value of `settings.role`, not a role: `COLUMN_ROLES` does
 * not list it, and nothing ever resolves TO it.
 *
 * Mirrors `server/src/utils/columnRoles.js`. Keep the two role tables equal.
 */

/** The roles a column may carry. */
export const COLUMN_ROLES = ['dueDate', 'assignee'];

/**
 * `settings.role` for "explicitly no role" — see the header. The server writes
 * it when a role is cleared from a column the template would otherwise vouch
 * for, and when claiming a role on one column releases it from another.
 */
export const NO_ROLE = 'none';

/** The column type a role requires — a "due date" that is a text column is not one. */
const ROLE_TYPE = { dueDate: 'date', assignee: 'person' };

/**
 * Template key → column key → role, as the server's templates stamp them.
 *
 * The client's copy of what `server/src/utils/boardTemplates.js` carries on its
 * columns. Only needed for boards created before those columns carried
 * `settings.role` — a board made today reads step 1 and never gets here.
 */
export const TEMPLATE_COLUMN_ROLES = {
  billing: { due: 'dueDate', owner: 'assignee' },
  budget: { owner: 'assignee' },
  pipeline: { closeDate: 'dueDate', owner: 'assignee' },
  recruitment: { nextRound: 'dueDate', interviewer: 'assignee' },
  expenses: { who: 'assignee' },
  content: { publishDate: 'dueDate', writer: 'assignee' },
};

/** The keys boards used before templates, when a due date was always `due_date`. */
const LEGACY_KEY_ROLES = { due_date: 'dueDate', assignees: 'assignee' };

const isRole = (role) => COLUMN_ROLES.includes(role);

/**
 * Where a column's role comes from — the three steps in the header, in order.
 * `roleColumn` ranks candidates by this, so the order is load-bearing.
 */
const ROLE_SOURCES = ['own', 'template', 'legacy'];

/**
 * The role `col` plays on `board` and which step supplied it, or null.
 *
 * A column that states a role of its OWN is judged by that alone — one whose
 * own role is `assignee` is not ALSO the template's due date just because its
 * key happens to be `due`. The template and the legacy keys only ever SUPPLY a
 * role a column does not state, the same as the server copy — and `NO_ROLE` is
 * a column stating that it has none, so they supply nothing to it either.
 */
const roleOf = (board, col) => {
  if (!col) return null;
  const own = col.settings?.role;
  if (isRole(own)) return { role: own, source: 'own' };
  if (own === NO_ROLE) return null;

  const fromTemplate = TEMPLATE_COLUMN_ROLES[board?.templateKey]?.[col.key];
  if (isRole(fromTemplate)) return { role: fromTemplate, source: 'template' };

  const legacy = LEGACY_KEY_ROLES[col.key];
  return isRole(legacy) ? { role: legacy, source: 'legacy' } : null;
};

/**
 * The role `col` plays on `board`, or null.
 *
 * Says nothing about the column's TYPE — `roleColumn` is where a role and a
 * type have to agree. Kept separate so a settings screen can show a stale role
 * on a column whose type has since changed, rather than having it vanish.
 */
export const columnRole = (board, col) => roleOf(board, col)?.role ?? null;

/**
 * The column that plays `role` on `board`, or null.
 *
 * Ranked by WHERE the role came from before by position: a column that states
 * the role itself beats one the template assigns it to, which beats a legacy
 * key. Within one rank, the first in array order — array order, not `order`,
 * so this agrees with `ledgerColumns` and with the server copy, which reads
 * the same array.
 *
 * Position alone got this wrong on the board the role setting exists for: a
 * billing board where someone stamped `role: 'dueDate'` on a NEW date column
 * added after the template's `due` still synced the old `due`, because `due`
 * came first and the template vouched for it — so the explicit choice lost to
 * the inferred one.
 *
 * Only a column of the role's type qualifies — a `dueDate` must be a date
 * column and an `assignee` a person column — at every rank.
 */
export const roleColumn = (board, role) => {
  if (!isRole(role)) return null;
  const columns = Array.isArray(board?.columns) ? board.columns : [];
  const candidates = columns.filter((c) => c && c.type === ROLE_TYPE[role]);
  for (const source of ROLE_SOURCES) {
    const hit = candidates.find((c) => {
      const r = roleOf(board, c);
      return r?.role === role && r.source === source;
    });
    if (hit) return hit;
  }
  return null;
};

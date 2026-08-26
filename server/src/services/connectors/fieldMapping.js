/**
 * Field mapping — the generic half.
 *
 * ---- What "generic" means here ---------------------------------------------
 *
 * Nothing in this file names a provider, a field, or a snapshot kind. It takes a
 * field descriptor out of some provider's own catalog (`ubersuggest/fields.js`,
 * and one per provider after it) and a TARGET on the goal, and answers three
 * questions:
 *
 *   - where on a goal may a value land at all?          → `GOAL_BUILTINS`,
 *                                                         `targetsForBoard`
 *   - may THIS field land on THAT target?               → `checkCompatibility`
 *   - what does one target look like on the wire?       → `targetId`,
 *                                                         `parseTargetId`
 *
 * Same split as `snapshotService.js` next door: the provider directory knows
 * what its data means, and this side knows what our goals can hold. The moment
 * this file gains an `if (provider === …)` the seam is gone.
 *
 * Phase 5 added the other three questions, for the same reason and on the same
 * side of the seam:
 *
 *   - what is in that cell right now?                  → `readGoalTarget`
 *   - has a human moved it since we wrote it?          → `sameCellValue`,
 *                                                        `isEmptyCellValue`
 *   - does this goal's TYPE even have that field?      → `targetAppliesTo`
 *
 * ---- Why compatibility is decided at CONFIGURATION time --------------------
 *
 * The failure this prevents is the silent one. A text field bound to a number
 * column does not break anything at save time — it breaks at 3am inside a
 * weekly run, on one field of one board, and the only symptom is a cell that
 * never fills. Nobody reports that as a bug for a month.
 *
 * So the check runs when somebody presses save, and the refusal is a SENTENCE
 * naming both sides. The panel gets the same sentences from the same function,
 * so an option that cannot be chosen says why before it is chosen rather than
 * after.
 *
 * ---- Why targets are named by `_id`, never by key --------------------------
 *
 * `Board.goalColumns[]` carries both a `key` slug and an `_id`, and the slug is
 * the tempting one to store because it is readable. It is also per-board and
 * unstable in practice: the three SEO boards in this workspace use disjoint
 * column ObjectIds, and the difficulty column is spelled `keyword_difficultly`
 * on one and `keyword_difficulty` on the other two. A mapping keyed by slug
 * would bind on one board and silently miss on the others, and the miss looks
 * exactly like "the connector has not run yet".
 *
 * `Goal.columnValues` is keyed by `_id` for the same reason, which is also what
 * makes renaming a column free. The mapping follows it.
 */

/**
 * Where on a goal a connector value may land, besides a goal column.
 *
 * ---- `capability` is the load-bearing field --------------------------------
 *
 * `goalController.RESULT_ONLY_FIELDS` splits a goal in half: `actual`,
 * `actualDayKey` and `columnValues` are the RESULT, writable with `goal.track`;
 * everything in `config` is the PROMISE and needs `goal.manage`, a strictly
 * higher rung. So a mapping onto `config.target` is a materially bigger
 * permission than one onto `actual`, and a person choosing between them in a
 * dropdown must be told that before they choose — not discovered when the sync
 * refuses.
 *
 * ---- Why `actual` and `actualDayKey` are two entries -----------------------
 *
 * `goalTypes.js` gives every type its own `actualField`, and `deadline` is the
 * one whose answer is a calendar date rather than a number — it writes
 * `actualDayKey`, not `actual`. Declaring both here, with their types, is what
 * lets the writeback pick the right one from the goal's type instead of
 * branching on the word "deadline".
 *
 * ---- `period` is the other load-bearing field ------------------------------
 *
 * A rank goal reads "5 → 3": the STARTING POINT is where the keyword stood when
 * the month began, and the RESULT is where it ended up. Both come from the same
 * field of the same provider report — they differ only in WHICH WEEK'S reading
 * is used. Without this, a mapping of `rank → config.baseline` would fill the
 * starting point with this week's rank and the goal would score itself against
 * itself, forever, at 0% or 100% and never anything in between.
 *
 *   `latest`     — the newest reading inside the goal's month.
 *   `monthStart` — where it stood when the month began: the last reading at or
 *                  before the first of the month, falling back to the earliest
 *                  reading inside it for a link made mid-month.
 */
const GOAL_BUILTINS = [
  {
    key: 'actual',
    label: 'Result',
    blurb: 'The number recorded at the end of the month.',
    type: 'number',
    capability: 'goal.track',
    period: 'latest',
  },
  {
    key: 'actualDayKey',
    label: 'Date it was done',
    blurb: 'Deadline goals only — every other type records a number instead.',
    type: 'date',
    capability: 'goal.track',
    period: 'latest',
  },
  {
    key: 'config.baseline',
    label: 'Starting point',
    blurb:
      'Where the month started from. Part of what was PROMISED, so changing it ' +
      'needs permission to manage goals rather than just to fill them in. ' +
      'Filled from where the number stood when the month began, not from today.',
    type: 'number',
    capability: 'goal.manage',
    period: 'monthStart',
  },
  {
    key: 'config.target',
    label: 'Target',
    blurb:
      'Where the month is meant to get to. Part of what was PROMISED, so ' +
      'changing it needs permission to manage goals.',
    type: 'number',
    capability: 'goal.manage',
    period: 'latest',
  },
];

const BUILTIN_BY_KEY = new Map(GOAL_BUILTINS.map((b) => [b.key, b]));

/** Every goal-column type, as `Board.goalColumns[].type` declares them. */
const COLUMN_TYPES = ['text', 'number', 'date', 'dropdown', 'link', 'person'];

/**
 * Which target types each source type may be written into.
 *
 * Widening is allowed, narrowing is not — a number reads perfectly well as text,
 * and text cannot be trusted to read as a number. That asymmetry is the whole
 * table:
 *
 *   - `dropdown` accepts NOTHING. Its values are this board's own vocabulary,
 *     chosen by a person; a provider string that failed to match an option would
 *     be written as a value no cell can render and no filter can find.
 *   - `person` accepts NOTHING. No connector field is a member of your team.
 *
 * Both refusals are stated rather than implied, because "why is this greyed
 * out" is the question the panel exists to answer in advance.
 */
const ACCEPTS = {
  number: ['number', 'text'],
  text: ['text'],
  date: ['date', 'text'],
  link: ['link', 'text'],
};

const TYPE_LABEL = {
  number: 'a number',
  text: 'text',
  date: 'a date',
  link: 'a link',
  dropdown: 'one of a fixed list of options',
  person: 'a member of your team',
};

/** Every source type a provider catalog is allowed to declare. */
const SOURCE_TYPES = Object.keys(ACCEPTS);

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * The wire form of a target — one string, so it can be a `Dropdown` value.
 *
 * `column:<objectId>` or `builtin:<key>`. Deliberately readable rather than
 * opaque: the same argument as `ConnectorSnapshot.variant`, which is
 * `desktop|en|2840` rather than a hash. Somebody will be reading one of these
 * off a document in a shell.
 *
 * @param {{kind: string, columnId?: any, builtin?: string}} target
 * @returns {string|null}
 */
const targetId = (target) => {
  if (!target) return null;
  if (target.kind === 'goalColumn' && target.columnId) {
    return `column:${String(target.columnId)}`;
  }
  if (target.kind === 'goalBuiltin' && target.builtin) {
    return `builtin:${target.builtin}`;
  }
  return null;
};

/**
 * Parse the wire form back. Returns null for anything unrecognised — including
 * a builtin key that is not in the catalog, so a client cannot invent one.
 *
 * @param {string} id
 * @returns {{kind: string, columnId?: string, builtin?: string}|null}
 */
const parseTargetId = (id) => {
  if (typeof id !== 'string') return null;
  const [prefix, ...rest] = id.split(':');
  const value = rest.join(':');
  if (!value) return null;
  if (prefix === 'column') return { kind: 'goalColumn', columnId: value };
  if (prefix === 'builtin') {
    return BUILTIN_BY_KEY.has(value) ? { kind: 'goalBuiltin', builtin: value } : null;
  }
  return null;
};

/**
 * Everything on this board a connector value could be written to.
 *
 * ARCHIVED COLUMNS ARE INCLUDED, flagged rather than hidden. A board that
 * archived a column still holds its values and can un-archive it, so a mapping
 * onto one is not wrong — but it will fill a cell nobody can see, and that is
 * worth saying. `offerable` is false for them, which is what stops the panel
 * offering one as a NEW binding while still being able to render an existing
 * one honestly.
 *
 * @param {Object} board - a Board document or lean object
 * @returns {Array<Object>}
 */
const targetsForBoard = (board) => {
  const columns = Array.isArray(board?.goalColumns) ? board.goalColumns : [];
  const columnTargets = columns
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((col) => ({
      id: `column:${String(col._id)}`,
      kind: 'goalColumn',
      columnId: String(col._id),
      label: col.name,
      type: col.type,
      // Every goal column is part of the RESULT half of a goal, so filling one
      // is the lower rung. See GOAL_BUILTINS' header.
      capability: 'goal.track',
      // A goal column describes the goal as it stands, so it takes the newest
      // reading. Only `config.baseline` looks backwards.
      period: 'latest',
      archived: !!col.archived,
      offerable: !col.archived,
      group: 'Goal columns',
    }));

  const builtinTargets = GOAL_BUILTINS.map((b) => ({
    id: `builtin:${b.key}`,
    kind: 'goalBuiltin',
    builtin: b.key,
    label: b.label,
    blurb: b.blurb,
    type: b.type,
    capability: b.capability,
    period: b.period,
    archived: false,
    offerable: true,
    group: 'The goal itself',
  }));

  return [...columnTargets, ...builtinTargets];
};

/** Find one resolved target by its wire id. @returns {Object|null} */
const findTarget = (board, id) =>
  targetsForBoard(board).find((t) => t.id === id) || null;

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/**
 * May this field be written to this target?
 *
 * The refusal names BOTH sides, because "incompatible types" tells somebody
 * nothing they can act on. A person reading "Search intent is text, and
 * “Volume” holds a number" knows immediately which half they got wrong.
 *
 * @param {Object} field  - an entry from a provider's field catalog
 * @param {Object} target - a resolved target from `targetsForBoard`
 * @returns {{ok: boolean, reason: string|null}}
 */
const checkCompatibility = (field, target) => {
  if (!field) return { ok: false, reason: 'That connector field does not exist.' };
  if (!target) return { ok: false, reason: 'That column is not on this board.' };

  const accepts = ACCEPTS[field.type];
  if (!accepts) {
    // A provider catalog declaring a type this file has never heard of. Refuse
    // rather than default to permissive: an unknown type is exactly the case
    // where we cannot say what would happen at write time.
    return {
      ok: false,
      reason: `${field.label} has a type this board cannot store.`,
    };
  }

  if (accepts.includes(target.type)) return { ok: true, reason: null };

  if (target.type === 'dropdown') {
    return {
      ok: false,
      reason:
        `“${target.label}” holds one of this board’s own options, chosen by a ` +
        'person. A value from the connector would not match one, so it would ' +
        'land in a cell nothing can render.',
    };
  }
  if (target.type === 'person') {
    return {
      ok: false,
      reason: `“${target.label}” holds a member of your team, and no connector field is a person.`,
    };
  }

  return {
    ok: false,
    reason:
      `${field.label} is ${TYPE_LABEL[field.type] || field.type}, and ` +
      `“${target.label}” holds ${TYPE_LABEL[target.type] || target.type}.`,
  };
};

/**
 * Every refusal for one field across one board's targets, keyed by target id.
 *
 * ABSENCE MEANS ALLOWED. Sending only the refusals halves the payload and, more
 * usefully, means the client has no rule of its own to get wrong — it looks up a
 * sentence and either finds one or does not. There is exactly one implementation
 * of the compatibility rule and it is `checkCompatibility` above; the same
 * argument as scoring living once in `goalTypes.js`.
 *
 * @param {Object} field
 * @param {Array<Object>} targets
 * @returns {Object<string, string>}
 */
const refusalsFor = (field, targets) => {
  const out = {};
  for (const target of targets) {
    const verdict = checkCompatibility(field, target);
    if (!verdict.ok) out[target.id] = verdict.reason;
  }
  return out;
};

/**
 * A provider field in a shape safe to serialise.
 *
 * Hand-built for the same reason `publicAccount` and `publicSnapshot` are, and
 * with one specific omission that matters: `read` is a FUNCTION. A spread would
 * drop it silently through JSON and leave a field entry that looks complete and
 * cannot extract anything — the sort of bug that only shows up in phase 5.
 *
 * @param {Object} field
 * @param {Array<Object>} [targets] - when given, adds the per-target refusals
 * @returns {Object}
 */
const publicField = (field, targets = null) => {
  const out = {
    key: field.key,
    label: field.label,
    blurb: field.blurb || '',
    type: field.type,
    kind: field.kind,
    scope: field.scope,
    derived: !!field.derived,
    nullMeans: field.nullMeans || null,
    accepts: ACCEPTS[field.type] || [],
  };
  if (targets) out.refusals = refusalsFor(field, targets);
  return out;
};

// ---------------------------------------------------------------------------
// Reading and comparing a goal cell — the writeback's half
// ---------------------------------------------------------------------------

/**
 * Is this cell empty, in the sense the connector cares about?
 *
 * `0` IS A VALUE. A rank of zero is impossible so it never arises there, but a
 * checklist result of 0 and an audit error count of 0 are both real readings,
 * and treating them as empty would make the connector overwrite a deliberate
 * zero on every run — the exact clobber the ownership test exists to prevent.
 * `false` is a value too: a `boolean` goal stores its "no" as 0, but a column
 * could hold a genuine false.
 *
 * @param {any} value
 * @returns {boolean}
 */
const isEmptyCellValue = (value) =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

/**
 * Do these two cell values mean the same thing?
 *
 * The ownership test in the writeback is "does the cell still hold what we put
 * there", and it has to survive a round trip through mongoose. A number written
 * as `4` comes back as `4`; a day key written as `'2026-08-14'` comes back as a
 * string; a `Map` value that went in as a number can come back as one. What it
 * must NOT do is call `4` and `'4'` different, because a `number` field mapped
 * into a `text` column is a widening this file explicitly allows — and if the
 * comparison failed there, the connector would decide a human had edited the
 * cell one run after writing it itself, and never write it again.
 *
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
const sameCellValue = (a, b) => {
  if (isEmptyCellValue(a) && isEmptyCellValue(b)) return true;
  if (isEmptyCellValue(a) || isEmptyCellValue(b)) return false;
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(a).getTime();
    const tb = b instanceof Date ? b.getTime() : new Date(b).getTime();
    return !Number.isNaN(ta) && !Number.isNaN(tb) && ta === tb;
  }
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  return String(a) === String(b);
};

/**
 * What is in the cell this target names, right now.
 *
 * Handles the one shape trap in `Goal`: `columnValues` is a mongoose `Map`, so
 * it is `.get(id)` on a document and a plain object after `.lean()`. Every
 * caller here gets one function rather than each remembering which it holds.
 *
 * @param {Object} goal - a Goal document or lean object
 * @param {{kind: string, columnId?: any, builtin?: string}} target
 * @returns {any}
 */
const readGoalTarget = (goal, target) => {
  if (!goal || !target) return null;
  if (target.kind === 'goalColumn') {
    const id = String(target.columnId);
    const values = goal.columnValues;
    if (!values) return null;
    if (typeof values.get === 'function') return values.get(id) ?? null;
    return values[id] ?? null;
  }
  if (target.kind !== 'goalBuiltin') return null;
  if (target.builtin === 'actual') return goal.actual ?? null;
  if (target.builtin === 'actualDayKey') return goal.actualDayKey ?? null;
  if (target.builtin === 'config.baseline') return goal.config?.baseline ?? null;
  if (target.builtin === 'config.target') return goal.config?.target ?? null;
  return null;
};

/**
 * Does a goal of this TYPE actually have the field this target names?
 *
 * `goalTypes.js` gives every type its own `configFields` and `actualField`, and
 * they genuinely differ: a `checklist` promises a `total` and has no `target`,
 * a `threshold` has a `limit` and an optional `baseline`, a `deadline` records
 * `actualDayKey` and has no numeric `actual` at all. A mapping is per BOARD and
 * a board's goals are a mixture of types, so the same mapping meets all of them.
 *
 * Writing `config.target` onto a checklist would add a key the type's scorer
 * never reads — invisible, permanent, and wrong the moment somebody switched
 * that goal to `numeric` and found a target they never set. Writing `actual`
 * onto a deadline goal would put a number where a day key belongs and the
 * scorer would read it as unanswered forever.
 *
 * So the check is against the type's own declaration rather than a list of type
 * names here. A goal type added later is covered without touching this file.
 *
 * A goal COLUMN is always available: columns are the board's shared schema and
 * every goal on the board carries them regardless of type.
 *
 * @param {{kind: string, builtin?: string}} target
 * @param {Object} typeSpec - the entry from `utils/goalTypes.js`
 * @returns {boolean}
 */
const targetAppliesTo = (target, typeSpec) => {
  if (!target) return false;
  if (target.kind === 'goalColumn') return true;
  if (target.kind !== 'goalBuiltin' || !typeSpec) return false;

  if (target.builtin === 'actual' || target.builtin === 'actualDayKey') {
    return typeSpec.actualField?.key === target.builtin;
  }
  const configKey = target.builtin.startsWith('config.')
    ? target.builtin.slice('config.'.length)
    : null;
  if (!configKey) return false;
  return (typeSpec.configFields || []).some((f) => f.key === configKey);
};

module.exports = {
  GOAL_BUILTINS,
  COLUMN_TYPES,
  SOURCE_TYPES,
  ACCEPTS,
  TYPE_LABEL,
  targetId,
  parseTargetId,
  targetsForBoard,
  findTarget,
  checkCompatibility,
  refusalsFor,
  publicField,
  // Phase 5 — the writeback's half. Pure, and what its tests assert on.
  isEmptyCellValue,
  sameCellValue,
  readGoalTarget,
  targetAppliesTo,
};

/**
 * The rules for turning a board into a tracker board, and back.
 *
 * PURE — takes plain objects, touches no database, throws nothing. Same
 * discipline as [trackerEvaluate.js](./trackerEvaluate.js): the decision about
 * whether a conversion is allowed is separable from performing it, and keeping
 * it separable is what makes the dry-run preview and the real conversion
 * provably agree. Two code paths that decide "can this board convert?"
 * differently is the bug this file exists to prevent — the preview would tell
 * you yes and the commit would tell you no.
 *
 * Both callers use it: `POST /api/boards/:id/convert` and
 * `scripts/migrateMonthlyBoards.js`.
 */

const { isValidTimezone } = require('./tzDay');

const CONVERTIBLE_TO = ['tracker', 'standard'];

/**
 * May this board convert, and what should the user be warned about?
 *
 * @param {Object}  args
 * @param {Object}  args.board     - a board doc or plain object; reads
 *                                   `boardType`, `monthTimezone`, `useFlexibleColumns`
 * @param {string}  args.to        - 'tracker' | 'standard'
 * @param {string} [args.timezone] - IANA zone, required when converting TO monthly
 *                                   unless the board already carries one
 * @returns {{ ok, noop, refusals: string[], warnings: string[], timezone: string|null }}
 *   `ok` false means do nothing and show `refusals`. `noop` true means the board
 *   is already in the requested state — not an error, just nothing to do.
 */
const checkConversion = ({ board, to, timezone } = {}) => {
  const refusals = [];
  const warnings = [];

  if (!board) {
    return { ok: false, noop: false, refusals: ['Board not found.'], warnings, timezone: null };
  }

  if (!CONVERTIBLE_TO.includes(to)) {
    refusals.push(`Unknown board type "${to}". Expected one of: ${CONVERTIBLE_TO.join(', ')}.`);
    return { ok: false, noop: false, refusals, warnings, timezone: null };
  }

  // A client board is refused in BOTH directions, and there is no override.
  // The client plane assumes a group is one client's live queue: portal tokens,
  // the ticket sequence, and every `portalShared` row. Partitioning that by
  // month would hide a client's own open ticket from them the moment the month
  // rolled over — the client would see their request vanish, not move.
  if (board.boardType === 'client') {
    refusals.push(
      'Client Portal boards cannot become tracker boards. A client would lose sight '
      + 'of their own open requests as soon as the month changed.'
    );
    return { ok: false, noop: false, refusals, warnings, timezone: null };
  }

  if (board.boardType === to) {
    // Already the requested type — nothing to convert. An explicitly supplied
    // timezone still wins over the stored one, though: "already monthly" does
    // NOT mean "already in the right timezone", and a caller refiling after a
    // zone change needs the zone it asked for, not the stale one it is
    // replacing. Returning `board.monthTimezone` here made a refile silently
    // recompute every month against the very timezone being changed away from,
    // which looks exactly like "nothing needed changing".
    const requested = to === 'tracker' && timezone && isValidTimezone(timezone)
      ? timezone
      : board.monthTimezone || null;
    return { ok: true, noop: true, refusals, warnings, timezone: requested };
  }

  if (to === 'tracker') {
    const tz = timezone || board.monthTimezone || null;
    if (!isValidTimezone(tz)) {
      refusals.push(
        tz
          ? `"${tz}" is not a timezone this server recognises.`
          : 'A timezone is required — it decides which month a task belongs to.'
      );
      return { ok: false, noop: false, refusals, warnings, timezone: null };
    }

    if (board.useFlexibleColumns) {
      // Not a conflict — nothing about monthKey touches Board.columns or
      // Task.columnValues. It is an expectation mismatch worth naming, because
      // the Goals tab deliberately does NOT reuse the flexible-columns grid.
      warnings.push(
        'This board uses flexible columns. Your task columns are unaffected, but the '
        + 'Goals tab has its own simpler column system rather than reusing them.'
      );
    }

    return { ok: true, noop: false, refusals, warnings, timezone: tz };
  }

  // to === 'standard' — reverting.
  warnings.push('The Delivery and Goals tabs will disappear from this board.');
  warnings.push(
    'Nothing is deleted: every task keeps its month, and your goals and trackers are '
    + 'kept. Switching back to monthly restores the board exactly as it is now.'
  );
  return { ok: true, noop: false, refusals, warnings, timezone: board.monthTimezone || null };
};

/**
 * What a conversion will visibly do, for the confirm dialog. Separate from
 * `warnings` on purpose: these are consequences the user WANTS, not caveats.
 */
const describeEffects = (to) =>
  to === 'tracker'
    ? [
      'The board will show one month at a time, with a month picker at the top.',
      'A Delivery tab will appear for recurring commitments.',
      'A Monthly Goals tab will appear, empty until you add goals.',
    ]
    : [
      'The board will show every task again, regardless of month.',
      'The Delivery and Goals tabs will be hidden.',
    ];

module.exports = { CONVERTIBLE_TO, checkConversion, describeEffects };

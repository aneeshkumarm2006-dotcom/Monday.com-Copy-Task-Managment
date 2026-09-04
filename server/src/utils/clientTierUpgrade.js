/**
 * The rules for upgrading a client board from `basic` to `advanced`.
 *
 * PURE — takes plain objects, touches no database, throws nothing. Same
 * discipline as [trackerBoardConvert.js](./trackerBoardConvert.js), and for the
 * same reason: the decision about whether an upgrade is allowed is separable
 * from performing it, and keeping it separable is what makes the confirmation
 * dialog and the actual write provably agree. Two code paths that decide "can
 * this board upgrade?" differently is the bug this file exists to prevent — the
 * dialog would promise something the endpoint then refuses.
 *
 * ---- Why the upgrade is one-way -------------------------------------------
 *
 * `advanced` is not a feature flag. It is a statement about the DATA: that this
 * board holds exactly one client company. Everything the tier switches on rests
 * on that — every contact on the board may read every workstream's room, and
 * one shared set of channels serves all of them.
 *
 * Reverting the flag would not un-send those messages, would not un-share what
 * each contact has already read, and would leave a board whose history assumes
 * one thing while its label claims another. So there is no downgrade: not in
 * this module, not on a route, and `Board`'s own hooks refuse it a third time.
 *
 * The honest consequence, which the confirmation dialog must say out loud: if a
 * board turns out to hold TWO client companies, upgrading it is a disclosure,
 * not an inconvenience. That is why `describeEffects` leads with who gains
 * access rather than with what gets switched on.
 */

const { isClientBoard } = require('./clientBoard');

/**
 * May this board upgrade to `advanced`, and what should the user be warned about?
 *
 * @param {Object} args
 * @param {Object} args.board - a board doc or plain object; reads `boardType`,
 *                              `portalTier`, `portalEnabled`
 * @param {number} [args.groupCount] - how many workstreams the board has, if
 *                              known. Only used to warn; never to refuse.
 * @param {number} [args.contactCount] - how many client contacts the board has,
 *                              if known. Only used to warn.
 * @returns {{ ok: boolean, noop: boolean, refusals: string[], warnings: string[] }}
 *   `ok` false means do nothing and show `refusals`. `noop` true means the board
 *   is already advanced — not an error, just nothing to do.
 */
const checkUpgrade = ({ board, groupCount = null, contactCount = null } = {}) => {
  const refusals = [];
  const warnings = [];

  if (!board) {
    return { ok: false, noop: false, refusals: ['Board not found.'], warnings };
  }

  if (!isClientBoard(board)) {
    refusals.push(
      'Only Client Portal boards have a portal tier. This board is not one.'
    );
    return { ok: false, noop: false, refusals, warnings };
  }

  if (board.portalTier === 'advanced') {
    // Already there. Deliberately not an error: the endpoint is idempotent, so
    // a double-submitted confirmation dialog must not surface a failure.
    return { ok: true, noop: true, refusals, warnings };
  }

  // A board with no workstreams upgrades fine — it just has no rooms yet, and
  // gains a pair the moment someone adds the first group. Worth saying, because
  // "I upgraded and the Chat tab is empty" otherwise reads as a broken feature.
  if (groupCount === 0) {
    warnings.push(
      'This board has no workstreams yet, so there are no chat rooms to create. '
      + 'Each workstream you add will get a team-only room and a client-facing one.'
    );
  }

  // The load-bearing warning. Everything advanced switches on assumes one
  // company per board, so the number of people who are about to be able to
  // read each other's rooms is the thing to check before confirming.
  if (contactCount !== null && contactCount > 0) {
    warnings.push(
      `${contactCount} client contact${contactCount === 1 ? '' : 's'} on this board `
      + 'will be able to read and post in every client-facing room. Make sure they '
      + 'all belong to the same company.'
    );
  }

  if (!board.portalEnabled) {
    warnings.push(
      'This portal is currently disabled, so clients cannot reach the chat until '
      + 'you turn the link back on.'
    );
  }

  return { ok: true, noop: false, refusals, warnings };
};

/**
 * What the upgrade will visibly do, for the confirm dialog. Separate from
 * `warnings` on purpose: these are consequences the user WANTS, not caveats.
 *
 * Ordered so the access change is read first. The tempting order — features,
 * then the fine print — buries the only line that can cause harm.
 */
const describeEffects = () => [
  'Every client contact on this board gains a Chat tab in their portal.',
  'Each workstream gets two rooms: one team-only, and one your client can see.',
  'Your team can talk to the client per workstream instead of per request.',
  'This cannot be undone — a board cannot go back to Basic.',
];

module.exports = { checkUpgrade, describeEffects };

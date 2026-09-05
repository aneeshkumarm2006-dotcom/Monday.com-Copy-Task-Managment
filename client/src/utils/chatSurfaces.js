/**
 * What a SURFACE is, in one place — the client's copy.
 *
 * A workstream (a group on a client board) can hold up to four conversations,
 * one per `(mode, audience)` pair on `Channel`:
 *
 *                | audience:'team'        | audience:'client'
 *   -------------+------------------------+---------------------------
 *   mode:'chat'  | the private team room  | Slack-style room the client is in
 *   mode:'mail'  | (possible, not offered)| Gmail-style mailbox the client is in
 *
 * That is the whole model, and it is what makes this modular: adding a mode
 * later is a new value in this table, not new navigation and not a new
 * collection.
 *
 * ---- Why this file exists at all, next to the server's ----------------------
 *
 * `server/src/utils/chatSurfaces.js` is the same table and the same rules. This
 * is a deliberate MIRROR rather than a shared module, because there is no build
 * step that puts CommonJS server code into the Vite bundle, and the alternative
 * — the modal spelling `(mode, audience)` pairs by hand — is how the two halves
 * drift apart. Keep them in step: the wire names below are the ones the server
 * validates against, so a rename here that is not made there is a 400.
 *
 * What is NOT mirrored: `surfaceName` and `describeSurface`. Naming a stored
 * channel and phrasing a notification body are things only the server does, and
 * a second implementation of a name that ends up in the database is worse than
 * no implementation at all.
 *
 * DELIBERATELY REACT-FREE — no JSX, no hooks, no icons. It is imported by a
 * modal, a board tab and a plain `node --test` file, and the refusal rules
 * below are the kind of thing that has to be testable without a renderer or it
 * simply never gets tested.
 *
 * `mail`+`team` is representable and intentionally NOT offered: a team that
 * wants subject lines among themselves has the whole app for that, and every
 * extra choice in the setup modal is a choice someone has to make about every
 * workstream forever. It costs nothing to add later — one row in OFFERED.
 */

/**
 * The surfaces the picker offers, in display order. `key` is the wire name the
 * client sends and the server validates against; nothing outside this file may
 * spell a `(mode, audience)` pair by hand.
 */
export const OFFERED_SURFACES = [
  {
    key: 'clientChat',
    mode: 'chat',
    audience: 'client',
    label: 'Chat',
    blurb: 'Quick back-and-forth. One running stream.',
  },
  {
    key: 'clientMail',
    mode: 'mail',
    audience: 'client',
    label: 'Mail',
    blurb: 'Subject-lined threads, read one at a time.',
  },
  {
    key: 'team',
    mode: 'chat',
    audience: 'team',
    label: 'Team room',
    blurb: 'Private to the team. The client is never in it.',
  },
];

export const SURFACE_KEYS = OFFERED_SURFACES.map((s) => s.key);

/** The offered surface with this key, or null. */
export const surfaceByKey = (key) => OFFERED_SURFACES.find((s) => s.key === key) || null;

/**
 * The key for a stored channel, or null if it is a pair we do not offer (a
 * `mail`/`team` room, say, or a manual extra with no group). Display code uses
 * this to pick an icon; it must tolerate the unoffered pairs rather than throw,
 * because the model allows them and a future release may start offering one.
 */
export const keyForSurface = (mode, audience) =>
  OFFERED_SURFACES.find((s) => s.mode === mode && s.audience === audience)?.key || null;

/** Is this pair one the client (as in `ClientContact`) can ever be in? */
export const isClientFacing = (audience) => audience === 'client';

/**
 * Turn a picker selection into the surfaces to create — and refuse the one
 * outcome that must never happen.
 *
 * @param {Object} selection - `{ clientChat, clientMail, team }`, truthy = on
 * @param {Object} [opts]
 * @param {boolean} [opts.allowClientSurfaces=true] - false on a board that is
 *   not a LIVE client portal board, where a client-facing room would be readable
 *   by nobody and postable by nobody, but would still exist. (This used to also
 *   mean "not on the advanced tier"; there is no tier any more.)
 * @returns {{ok: boolean, surfaces: Array, refusals: string[]}}
 *
 * An EMPTY selection is refused rather than treated as "no change". A
 * workstream with no surfaces is a workstream nobody can talk in, and the modal
 * that produced this call exists precisely to stop that state being reached by
 * accident.
 *
 * ON THIS SIDE THE REFUSAL IS AN AFFORDANCE, NEVER THE ENFORCEMENT. All it does
 * here is disable the submit button and put the reason under it, so the person
 * finds out before the round trip instead of after it. The server runs the same
 * plan independently inside `createSurfaces`, and would refuse a hand-rolled
 * POST that never went near this modal.
 */
export const planSurfaces = (selection, { allowClientSurfaces = true } = {}) => {
  const sel = selection || {};
  const refusals = [];

  const chosen = OFFERED_SURFACES.filter((s) => Boolean(sel[s.key]));

  if (!chosen.length) {
    refusals.push('Pick at least one way to talk about this work.');
  }

  const clientChosen = chosen.filter((s) => isClientFacing(s.audience));
  if (clientChosen.length && !allowClientSurfaces) {
    refusals.push(
      'Client chat and mail need a live client portal board.'
    );
  }

  return {
    ok: refusals.length === 0,
    surfaces: refusals.length
      ? []
      : chosen.map((s) => ({ mode: s.mode, audience: s.audience, key: s.key })),
    refusals,
  };
};

/**
 * "Create 2 surfaces" — the submit button's label. The button names its
 * consequence, which is the convention every other create modal here follows,
 * and it is also the last chance the person has to notice they ticked
 * something they did not mean to.
 */
export const describePlan = (surfaces) => {
  const n = (surfaces || []).length;
  if (!n) return 'Create';
  return n === 1 ? 'Create 1 surface' : `Create ${n} surfaces`;
};

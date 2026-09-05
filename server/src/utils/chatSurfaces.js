/**
 * What a SURFACE is, in one place.
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
 * DELIBERATELY DEPENDENCY-FREE — no models, no mongoose. It is required by a
 * controller, a service, a migration and a plain `node --test` file, and the
 * naming and refusal rules below are the kind of thing that has to be testable
 * without a database or it simply never gets tested.
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
const OFFERED_SURFACES = [
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

const SURFACE_KEYS = OFFERED_SURFACES.map((s) => s.key);

/** The offered surface with this key, or null. */
const surfaceByKey = (key) => OFFERED_SURFACES.find((s) => s.key === key) || null;

/**
 * The key for a stored channel, or null if it is a pair we do not offer (a
 * `mail`/`team` room, say, or a manual extra with no group). Display code uses
 * this to pick an icon; it must tolerate the unoffered pairs rather than throw,
 * because the model allows them and a future release may start offering one.
 */
const keyForSurface = (mode, audience) =>
  OFFERED_SURFACES.find((s) => s.mode === mode && s.audience === audience)?.key || null;

/** Is this pair one the client (as in `ClientContact`) can ever be in? */
const isClientFacing = (audience) => audience === 'client';

/**
 * The stored `Channel.name` for a new surface.
 *
 * Names have to survive out of context, because they are what a notification
 * says: "mentioned you in #Ads". The team room therefore keeps the bare
 * workstream name — matching what tracker boards already do — and a
 * client-facing room names the company as well, since the whole point of it is
 * who else is in the room.
 *
 * Chat and mail on the same workstream share a name on purpose. They are the
 * same room in every sense a human cares about, differing only in how it is
 * read, and `describeSurface` below is what disambiguates them in the one place
 * it matters.
 */
const surfaceName = ({ audience, groupName, clientName }) => {
  const group = (groupName || '').trim() || 'Untitled workstream';
  if (!isClientFacing(audience)) return group;
  const client = (clientName || '').trim();
  return client ? `${group} · ${client}` : group;
};

/**
 * A phrase naming the surface for a notification body — "in #Ads · Acme Corp"
 * versus "in the Ads · Acme Corp mailbox". Mode is spelled out only for mail,
 * because `#` already reads as chat everywhere else in the product and a reader
 * who sees no qualifier should be able to assume the ordinary thing.
 */
const describeSurface = (channel) => {
  const name = channel?.name || 'a channel';
  return channel?.mode === 'mail' ? `the ${name} mailbox` : `#${name}`;
};

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
 * accident. The refusal is duplicated on the client only as an affordance — the
 * button is disabled — never as the enforcement.
 */
const planSurfaces = (selection, { allowClientSurfaces = true } = {}) => {
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
    surfaces: refusals.length ? [] : chosen.map((s) => ({ mode: s.mode, audience: s.audience, key: s.key })),
    refusals,
  };
};

/**
 * "Create 2 surfaces" — the submit button's label. The button names its
 * consequence, which is the convention every other create modal here follows,
 * and it is also the last chance the person has to notice they ticked
 * something they did not mean to.
 */
const describePlan = (surfaces) => {
  const n = (surfaces || []).length;
  if (!n) return 'Create';
  return n === 1 ? 'Create 1 surface' : `Create ${n} surfaces`;
};

module.exports = {
  OFFERED_SURFACES,
  SURFACE_KEYS,
  surfaceByKey,
  keyForSurface,
  isClientFacing,
  surfaceName,
  describeSurface,
  planSurfaces,
  describePlan,
};

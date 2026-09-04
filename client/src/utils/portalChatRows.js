/**
 * The two pure decisions behind the portal's chat and mail panes.
 *
 * Extracted out of the components purely so they can be tested: the client has
 * no JSX test harness (`npm test` is `node --test` over plain `.test.mjs`
 * utils), so logic that stays inside a component is logic that is never
 * asserted. Both of these are small and both are the kind of thing that fails
 * silently — a duplicated bubble, a tab that does not appear — rather than
 * throwing where anyone would see it.
 */

/**
 * Fold newly-arrived messages into the ones already on screen.
 *
 * THE PORTAL HAS TWO DELIVERY PATHS AND ALWAYS WILL. An SSE frame arrives the
 * instant a message is posted; a poll arrives up to `LIST_POLL` later with the
 * same message in it. The stream cannot replace the poll — the server's
 * connection registry is in-memory and single-process, so on a multi-instance
 * deploy a client connected to one instance never hears about a message posted
 * through another. So the same message reaches this function twice, routinely,
 * and de-duplication is the normal case rather than an edge one.
 *
 * Keyed on `id`, because that is the only thing stable across the two paths:
 * timestamps are equal-to-the-millisecond at best, and object identity is
 * meaningless across a JSON boundary.
 *
 * INCOMING WINS, and merges rather than replaces (`{...existing, ...incoming}`).
 * A polled copy carries fields a stream frame may not — `replyCount` is
 * computed only by the list endpoint — so a naive replace would make reply
 * counts flicker to undefined every time a message arrived live.
 *
 * Sorted ascending by `createdAt`, which is display order: the caller renders
 * oldest-first even though the API pages newest-first.
 *
 * @param {Array} prev - what is on screen
 * @param {Array} incoming - what just arrived, from either path
 * @returns {Array} a new array; neither input is mutated
 */
export const mergeMessages = (prev, incoming) => {
  const byId = new Map();
  (prev || []).forEach((m) => {
    if (m?.id) byId.set(m.id, m);
  });
  (incoming || []).forEach((m) => {
    if (!m?.id) return;
    byId.set(m.id, { ...byId.get(m.id), ...m });
  });
  return [...byId.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
};

/**
 * The workstreams that actually have a surface of this mode — which is what
 * decides whether the Chat or Mail tab exists at all.
 *
 * A workstream is dropped rather than shown empty, because the client cannot
 * create a surface: only the team can. Offering a client a mailbox that does
 * not exist gives them a dead tab and no way to ask for a live one.
 *
 * Tolerates a null/absent payload so the pane can render during the first load
 * without a guard at every call site.
 *
 * @param {Object} channels - the `GET /api/portal/me/chat/channels` payload
 * @param {'chat'|'mail'} mode
 * @returns {Array<{id, name, surface}>}
 */
export const streamsOfMode = (channels, mode) =>
  (channels?.workstreams || [])
    .map((w) => ({
      id: w.id,
      name: w.name,
      surface: (w.surfaces || []).find((s) => s.mode === mode),
    }))
    .filter((w) => w.surface);


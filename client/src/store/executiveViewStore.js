import { create } from 'zustand';
import * as executiveViewService from '../services/executiveViewService';

/**
 * The client's copy of the caller's own executive view.
 *
 * ---- THE INVARIANT THAT MAKES THIS STORE SAFE ------------------------------
 *
 * The profile describes a VIEW and never a grant. Nothing in this store — not
 * `fetchMine`, not `saveMine`, not a board entry somebody types into it — can
 * widen what the user reaches. Reach is the org role AND the per-board grant,
 * resolved only by `resolveAccess` on the server, and every board this profile
 * names was re-checked there before it arrived: `GET /api/me/executive-view`
 * drops the ones the caller can no longer read into `skipped[]`, and the self
 * PUT refuses to keep an entry for a board the caller cannot already open,
 * reporting it in `dropped`. So a stale, wrong or even hostile value in here
 * costs at worst a tile that 404s on click — never access to anything.
 *
 * That is also why `saveMine` replaces `profile` with the SERVER's answer rather
 * than the object it just sent: the server densifies `order`, clamps labels and
 * may have removed an entry outright, and a screen that showed the optimistic
 * local version would be showing something that was not saved.
 *
 * ---- WHAT `isExecutive` IS ------------------------------------------------
 *
 * `profile !== null`, and nothing else. It is exported as a SELECTOR rather than
 * kept as a second piece of state, because a boolean stored beside the thing it
 * is derived from is a boolean that will eventually disagree with it — and the
 * disagreement here decides which PAGE `/dashboard` renders.
 *
 * Note that it is false before the first load resolves, which is correct as a
 * value and dangerous as a render: an Executive would flash the standard
 * dashboard for as long as the fetch takes. Anything that switches on it must
 * therefore gate on `loading` / `loadedForOrg` FIRST — see `DashboardRoute` in
 * `App.jsx`, which is the reason those two fields are exposed at all.
 *
 * ---- WHO LOADS IT ----------------------------------------------------------
 *
 * One effect in `App.jsx`, keyed `[user?._id, currentOrgId]`, beside the holiday
 * calendar's. Not `orgStore`, and not a page: an executive shell is chrome (the
 * rail, the board list, the home page), so it has to be resolved once per person
 * per workspace before any of those render, and the org switch is the only event
 * that invalidates it. `orgStore.clearOrgs` clears this store.
 *
 * ---- AN ORG SWITCH CLEARS FIRST, THEN LOADS --------------------------------
 *
 * `fetchMine` for a DIFFERENT org than the loaded one empties `profile` and
 * `skipped` on the way in, rather than leaving the old workspace's answer
 * standing until the new one lands. `loadedForOrg` already tells a careful
 * reader that the answer is stale — `DashboardRoute` gates on exactly that —
 * but a store whose safety depends on every consumer remembering to check a
 * second field is a store that is one careless `useExecutiveViewStore((s) =>
 * s.profile...)` away from applying org A's shape inside org B. `SideRail`
 * reads `profile?.nav` and nothing else; with this it gets "no profile here"
 * for the duration of the switch, which is the truth, and the full rail, which
 * is the safe direction (invariant 6: a switch can only ever SUBTRACT).
 *
 * A refetch of the SAME org deliberately does not clear: there is no new answer
 * pending, only a fresher copy of the one on screen, and blanking the shell to
 * re-render it identically is a flicker with nothing behind it.
 *
 * Modelled on `permissionStore.js`, including its FAIL CLOSED rule.
 */

/**
 * Which `fetchMine` call is the current one.
 *
 * `permissionStore` does without this and is fine; this store is not, because
 * the answer here selects a whole PAGE. Switching workspaces twice quickly
 * leaves two requests in flight, and if the FIRST one lands last it would write
 * org A's profile under `loadedForOrg: A` — the gate would read "loaded, not an
 * executive" and render the standard dashboard for someone who is one, until
 * something else happened to re-fetch. So each call takes a ticket and a
 * superseded response is dropped on the floor rather than written.
 *
 * ONLY `fetchMine` (and `clear`) may move this number, and every bump must be
 * followed either by a response that lands or by a `set` that clears `loading`.
 * A superseded `fetchMine` returns WITHOUT touching `loading`, on the
 * assumption that the call which superseded it will turn the flag off when it
 * lands — so bumping the ticket from anywhere that is not itself a fetch (a
 * save, say) would orphan the request in flight and strand `loading: true`,
 * which is a permanent spinner on `/dashboard`. `saveMine` therefore guards
 * itself by comparing `loadedForOrg` instead; see its comment.
 */
let fetchTicket = 0;

/**
 * The not-an-Executive state. A FUNCTION, not a shared constant: `skipped` is an
 * array, and one object reused across every clear would hand every consumer the
 * same array to hold on to.
 */
const empty = () => ({ profile: null, skipped: [] });

const useExecutiveViewStore = create((set, get) => ({
  /**
   * The resolved profile, or null when this person is not an Executive in the
   * loaded workspace. Shape: `{ _id, organisation, user, boards[], home[], nav,
   * createdBy, updatedBy, createdAt, updatedAt }`.
   */
  profile: null,
  /**
   * `[{ board, name, reason }]` — board entries the server removed from
   * `profile.boards` on the way out because the caller can no longer read them.
   * Kept rather than discarded so the shell can say "two boards you can no
   * longer open are not shown" instead of quietly rendering a shorter list.
   */
  skipped: [],
  loading: false,
  /** The org id the current `profile` was resolved for; null means "not loaded". */
  loadedForOrg: null,

  /**
   * Load the caller's view for `orgId`.
   *
   * Resolves to the profile (or null) for callers that want it inline; the
   * store is the real output.
   */
  fetchMine: async (orgId) => {
    if (!orgId) {
      // No workspace selected — there is nothing to be an Executive OF. Cleared
      // rather than left alone so the previous org's shell cannot outlive it.
      fetchTicket += 1;
      set({ ...empty(), loading: false, loadedForOrg: null });
      return null;
    }

    const ticket = (fetchTicket += 1);
    if (get().loadedForOrg === orgId) {
      // A refresh of the workspace already on screen: keep it visible while the
      // fresher copy is fetched. Nothing about it is stale yet.
      set({ loading: true });
    } else {
      // A DIFFERENT workspace (or the first load). The profile on hand describes
      // a workspace nobody is looking at any more, so it goes now rather than
      // when the replacement arrives — see the header. `loadedForOrg: null`
      // because "not loaded" is the honest value for the beat in between, and it
      // is what stops `saveMine` from writing this screen's edits into the org
      // we just left.
      set({ ...empty(), loading: true, loadedForOrg: null });
    }
    try {
      const data = await executiveViewService.getMine(orgId);
      if (ticket !== fetchTicket) return get().profile; // superseded; see above
      set({
        profile: data?.profile || null,
        skipped: data?.skipped || [],
        loading: false,
        loadedForOrg: orgId,
      });
      return get().profile;
    } catch (err) {
      if (ticket !== fetchTicket) return get().profile;

      // A 404 means the same thing the 200-with-null body means: this person is
      // not an Executive here. The endpoint answers 200 today — the branch is
      // here so that a future route change, or a proxy that swallows the body,
      // cannot turn "no view" into an error that clears a view.
      //
      // EVERYTHING ELSE FAILS CLOSED, to `profile: null`. A failed fetch must
      // not leave a previous org's profile in place: that would render a board
      // list and a home page for a workspace the user is no longer looking at.
      // Closed here means the STANDARD app, which is the safe direction — the
      // profile only ever described a view, so falling back to it shows nothing
      // the user cannot already reach, it just shows more of it.
      set({
        ...empty(),
        loading: false,
        loadedForOrg: orgId,
      });
      if (err?.response?.status !== 404) {
        console.error('fetchMine (executive view) failed:', err);
      }
      return null;
    }
  },

  /**
   * Rewrite the caller's own shape. Pass only the part you are editing —
   * `{ boards }`, `{ home }`, `{ nav }`, or any combination.
   *
   * Takes no org id: it edits the profile that is loaded, and the org that
   * profile belongs to is `loadedForOrg`. Passing one would invite a caller to
   * save the shape on screen into a different workspace's document.
   *
   * ---- WHY THIS MERGES, AND WHY THE MERGE LIVES HERE ------------------------
   *
   * `PUT /api/me/executive-view` REPLACES the document. Nothing on either side
   * merges: the server's `validateShape` reads an absent `home` as "no sections"
   * and an absent `nav` as "every switch on", and `upsert` then assigns all
   * three fields unconditionally. So a literal `{ home }` on the wire does not
   * mean "change the home" — it means "change the home, and delete this
   * person's entire curated board list on the way past", answered with a 200 and
   * an empty `dropped`, with nothing anywhere to say what was lost.
   *
   * That is a trap every caller would otherwise have to know about and
   * re-discover — `MyBoardsPage`'s drag handler currently carries `home` and
   * `nav` back by hand, with a paragraph explaining why — and the cost of
   * forgetting is silent data loss, which is the worst kind of thing to leave as
   * a convention. So the store fills the gaps: the three parts of the body are
   * CONSTRUCTED here, each taken from `shape` when the caller supplied it and
   * from the loaded `profile` when they did not. A caller may still send all
   * three; passing a part explicitly always wins over the merge.
   *
   * Building the body rather than forwarding `shape` has a second effect worth
   * keeping: a stray key cannot ride along into a document whose validator would
   * either reject the save or quietly drop it.
   *
   * Round-tripping the server's own values back is safe by design — a home
   * section keeps its `_id` through the validator, and `nav` is stored
   * `_id: false` — and the profile in the store is always the server's last
   * answer, never a local edit.
   *
   * Returns the server's `{ profile, dropped }`. `dropped` is board ids the
   * server refused to keep because the caller cannot read them — surfaced to the
   * caller rather than swallowed, so the page can say "two boards you can no
   * longer open were removed from your list" instead of silently saving
   * something other than what was on screen. Throws on failure (the caller
   * toasts); the store is left alone, because a save that did not happen must
   * not look like one that did.
   */
  saveMine: async (shape) => {
    const { loadedForOrg: orgId, profile: current } = get();
    if (!orgId) throw new Error('No workspace loaded');

    const given = shape && typeof shape === 'object' ? shape : {};
    // `undefined` is the only thing that means "not editing this part". A
    // caller who really wants to clear one sends `[]` (or `{}` for nav's
    // defaults) and gets exactly that.
    const body = {
      boards: given.boards !== undefined ? given.boards : current?.boards || [],
      home: given.home !== undefined ? given.home : current?.home || [],
    };
    const nav = given.nav !== undefined ? given.nav : current?.nav;
    // Omitted rather than sent as undefined when there is nothing to carry over:
    // an absent `nav` is how the server spells "the defaults", and a profile
    // that has never had one written wants precisely that.
    if (nav !== undefined && nav !== null) body.nav = nav;

    try {
      const data = await executiveViewService.saveMine(orgId, body);
      // The workspace may have changed under this request — an org switch while
      // a drag was saving. The response is still the honest answer to what was
      // asked, so it is returned; it just must not be WRITTEN, or org A's
      // profile would sit in the store under org B's `loadedForOrg` and every
      // consumer would render A's shape inside B until something refetched.
      // Compared rather than ticketed: only `fetchMine` may move the ticket (see
      // its comment above), and this comparison covers `clear()` too, which
      // leaves `loadedForOrg` null.
      if (get().loadedForOrg !== orgId) return data || { profile: null, dropped: [] };
      // Only `profile` moves. `loading` belongs to `fetchMine` — a save is the
      // page's spinner, not the shell's, and flipping the shell's flag here
      // would make DashboardRoute undecided (and blank the page) mid-edit.
      // `loadedForOrg` is already `orgId`; it is where `orgId` came from.
      set({ profile: data?.profile || null }); // the SERVER's, not the local one
      return data || { profile: null, dropped: [] };
    } catch (err) {
      // 404 on the self PUT means the profile was deleted underneath this tab —
      // an admin removed the view while it was open. That is the same fact a
      // null GET reports, so it is adopted here: the shell steps aside and the
      // standard app comes back on the next render, which is exactly what
      // deleting a view is supposed to do (invariant 3). Still rethrown, so the
      // page that asked can say what happened.
      //
      // Same org guard as the success path, and for a sharper reason: writing
      // `loadedForOrg: orgId` after the user has moved to another workspace
      // would rewind the store to the one they left, and `DashboardRoute`'s
      // `loadedForOrg !== currentOrgId` test would then be true forever —
      // a spinner that never resolves, because nothing fetches again until the
      // next org switch.
      if (err?.response?.status === 404 && get().loadedForOrg === orgId) {
        set({ ...empty(), loadedForOrg: orgId });
      }
      throw err;
    }
  },

  clear: () => {
    // Invalidate any in-flight fetch too, or a response that was already on the
    // wire when the user signed out would write a profile into a cleared store.
    fetchTicket += 1;
    set({ ...empty(), loading: false, loadedForOrg: null });
  },
}));

/**
 * `isExecutive` — the one rule, in one place.
 *
 * Usable both as a zustand selector (`useExecutiveViewStore(selectIsExecutive)`,
 * which re-renders only when the answer changes) and against a snapshot
 * (`selectIsExecutive(useExecutiveViewStore.getState())`) for the handful of
 * callers outside React.
 */
export const selectIsExecutive = (state) => state.profile !== null;

/**
 * The same thing as a hook, for components that want the boolean and nothing
 * else. Kept beside the selector rather than inlined at each call site so that
 * "what makes someone an Executive" is answered in exactly one expression.
 */
export const useIsExecutive = () => useExecutiveViewStore(selectIsExecutive);

/**
 * The profile's entry for one board, or null — the per-board presets (label,
 * default tab, tab allowlist) live on it, and phase 3's board page reads them.
 * Here rather than in each caller because ids arrive both populated and bare,
 * and `String(x?._id || x)` is the comparison this codebase uses everywhere.
 */
export const selectBoardEntry = (boardId) => (state) => {
  const want = String(boardId?._id || boardId || '');
  if (!want || !state.profile) return null;
  return (
    (state.profile.boards || []).find(
      (entry) => String(entry?.board?._id || entry?.board || '') === want
    ) || null
  );
};

export default useExecutiveViewStore;

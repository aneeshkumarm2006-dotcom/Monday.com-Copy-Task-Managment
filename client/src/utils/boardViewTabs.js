/**
 * Resolving the board page's view tabs — and closing the trap that adding one
 * has walked into three times.
 *
 * ---- The bug this file exists to make impossible ----------------------------
 *
 * A tab is registered in `BoardDetailPage`'s `VIEW_TABS` with a `visible`
 * predicate that reads a key off a gate object built further down the file:
 *
 *     { value: 'seo', visible: (g) => g.canViewSeo }
 *
 * If the gate literal is missing `canViewSeo`, the predicate evaluates to
 * `undefined`, `undefined` is falsy, and the tab is filtered out. NO ERROR, NO
 * WARNING, NO BLANK SCREEN — the tab simply is not there, and `?view=seo`
 * validates against the resolved list, fails, and falls back to the board view.
 * The symptom is "the feature did not ship"; the cause is one missing key three
 * hundred lines away.
 *
 * There was a THIRD edit too, and it failed differently: the `useMemo` around
 * the resolution carried a hand-maintained dependency array. A tab whose gate
 * key was not listed there appeared only after some unrelated state changed —
 * so it worked in dev, where something always changes, and did not on a cold
 * load in production.
 *
 * Two mechanisms, one each:
 *
 *   `resolveViewTabs` reads the gate THROUGH A PROXY and throws by name when a
 *     predicate touches a key the gate does not define. A typo is now a loud,
 *     immediate, specific failure instead of a missing tab.
 *   `gateSignature` turns the gate into a stable string, so the memo depends on
 *     the gate's CONTENTS rather than on a list somebody has to remember to
 *     extend. There is nothing left to forget.
 *
 * ---- Why throwing is safe here ---------------------------------------------
 *
 * The gate is a literal built in one place from a fixed set of names. Whether a
 * predicate reads a key that exists is decided at author time, not by data — so
 * a build that renders the board page once anywhere has already proved it. There
 * is no input that can make this throw in production and not in development,
 * which is exactly what makes it a better failure than a silent hide.
 *
 * ---- The second filter: a per-person allowlist ------------------------------
 *
 * `resolveViewTabs` takes an optional `allow` list, which is how a curated
 * profile says "this board opens with two tabs, not nine". It is a
 * PRESENTATION preset and never a permission, and the whole of that distinction
 * is in the ORDER the two filters run: the capability gate decides which tabs
 * exist, and only then does the allowlist narrow that answer. A listed tab the
 * gate rejected stays rejected — there is no code path that can put it back —
 * so the worst a wrong, stale or hand-edited allowlist can do is show somebody
 * fewer tabs than they are entitled to, which is a screen they can fix, rather
 * than one more tab than they are entitled to, which is a breach.
 *
 * It lives HERE rather than as a branch in the board page for the same reason
 * everything else in this file does: one loop, one order, one place to test. A
 * page that filtered the resolved list itself would be a second subtraction
 * written somewhere the Proxy and the signature cannot see, which is precisely
 * the shape of the three bugs above.
 *
 * Note that the allowlist is NOT part of the gate, and therefore NOT part of
 * `gateSignature`. No predicate reads it — the filtering happens in the loop —
 * and the Proxy only ever throws for keys a predicate READS, so a key added to
 * the gate for this would be dead weight that still moved the signature. The
 * cost of keeping it out is that a caller memoising on `gateSignature` alone
 * would miss it; `BoardDetailPage` therefore adds it to that memo's key
 * explicitly, and says so where it does it.
 *
 * ---- What the allowlist hides, it hides from `?view=` too --------------------
 *
 * Worth stating plainly, because the design note this was built from is loose
 * about it and the opposite was once written here: a tab an allowlist removes
 * is NOT reachable by typing its URL. `resolveViewTabs` returns ONE list, and
 * `resolveView` validates the URL against that same list, so a preset-hidden
 * tab fails the check exactly as a capability-hidden one does and lands on the
 * fallback. That is the price of one list: the tab bar and the rendered pane
 * can never disagree about what exists, and nobody can be parked on a tab with
 * no entry in the bar to leave it by. The bill arrives on deep links — a link
 * built for a tab this reader's preset excludes opens on their fallback
 * instead, silently — so anything that MAKES such a link (the executive home's
 * section links) should offer the tab the reader can actually see.
 *
 * None of that turns the allowlist into a permission. It cannot reveal, only
 * remove; the gate has already had the only say about entitlement; and an admin
 * who needs a tab genuinely unreachable takes the capability away, which is the
 * mechanism that answers to the server.
 *
 * ---- Saying "the board tab" when silence no longer means it ------------------
 *
 * `viewParamFor` at the bottom is the other half of `resolveView`, and it only
 * exists because of the fallback. See its comment: the short version is that
 * deleting `?view=` used to spell "the board tab" and now spells "whatever this
 * reader's default is", so callers that navigate BACK to the rows need a rule
 * rather than a habit.
 *
 * No React, no JSX and no icons in this file: it is imported by a plain Node
 * test (`boardViewTabs.test.mjs`), which is the only way the property above can
 * be asserted rather than described.
 */

/**
 * @typedef {Object} ViewTab
 * @property {string} value            - the `?view=` value; also the React key
 * @property {string|Function} label   - a string, or `(gate) => string`
 * @property {Function} visible        - `(gate) => boolean`
 */

/**
 * The one tab that survives every allowlist.
 *
 * A board page with no tabs is a page you cannot use — there would be nothing
 * to click and nothing rendered — so `board`, the one view every board type
 * has, is not subtractable.
 *
 * This is the SECOND LOCK ON THE SAME DOOR. The profile's validator already
 * refuses to store an allowlist that omits it (`BASE_TAB` in
 * `server/src/services/executiveView.js`), so a list arriving here without
 * `board` should be impossible. "Should be impossible" is worth exactly as much
 * as the last person to edit the validator: the two checks run at different
 * times, and a document written before that rule existed, one hand-edited in
 * the database, or one saved by a future validator somebody loosened all reach
 * this loop anyway. The write-side check is what tells an admin they typed
 * something wrong; this one is what keeps the page openable regardless.
 *
 * @type {string}
 */
const BASE_TAB = 'board';

/**
 * A gate that refuses to answer for a key it does not have.
 *
 * `hasOwnProperty` rather than `in`, so a predicate reaching for `toString` or
 * `constructor` is caught too — those exist on the prototype and would otherwise
 * hand back a function, which is truthy, which would show a tab nobody meant to
 * register.
 *
 * Symbol keys are passed through untouched: the runtime probes objects with
 * `Symbol.toPrimitive` and friends, and none of those is a gate key.
 */
const auditedGate = (gate, tabValue) =>
  new Proxy(gate, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !Object.prototype.hasOwnProperty.call(target, prop)) {
        throw new Error(
          `Board view tab "${tabValue}" reads gate key "${prop}", which the gate does ` +
            'not define. Add it to the gate object in BoardDetailPage, or the tab ' +
            'would silently never appear.'
        );
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
  });

/**
 * Which tabs this board shows, with any function labels already resolved.
 *
 * Labels are resolved HERE rather than at the render site because the tab bar
 * renders `tab.label` straight into JSX, and a function there is a runtime
 * error rather than a heading.
 *
 * `options.allow` is the optional per-person allowlist described in the header.
 * Three properties hold, and `boardViewTabs.test.mjs` pins all three:
 *
 *   1. It can only SUBTRACT. The gate runs first and the allowlist filters its
 *      output, so a tab a capability hid is never shown by being listed.
 *   2. `BASE_TAB` always survives it — see above.
 *   3. Absent (`null`, `undefined`, or the argument not passed at all) it
 *      changes NOTHING. `allowed` is null, the second `continue` is
 *      unreachable, and what remains is the loop that was here before the
 *      allowlist existed. That is what makes this safe to add to the one board
 *      page the whole workspace shares: a reader with no profile takes the old
 *      path exactly, not a new path that happens to agree with it.
 *
 * @param {ViewTab[]} tabs
 * @param {Object} gate
 * @param {{ allow?: string[]|null }} [options]
 * @returns {ViewTab[]} with `label` always a string
 */
export const resolveViewTabs = (tabs, gate, { allow } = {}) => {
  /**
   * Normalised once, outside the loop, into a Set or into null.
   *
   * Anything that is not an array reads as "no allowlist" — `null` and
   * `undefined`, which is how a board with no preset spells it, and equally
   * anything malformed. Failing to the FULL set is the correct direction for a
   * control whose job is trimming noise rather than keeping secrets: the cost
   * of getting it wrong is a busier tab bar, never a tab the reader was not
   * entitled to, because the gate below has already had the only say about
   * that. Failing the other way would hide work from somebody because their
   * preset arrived corrupt, which is a far worse Tuesday than an extra tab.
   */
  const allowed = Array.isArray(allow) ? new Set(allow.map(String)) : null;

  const out = [];
  for (const tab of tabs) {
    const audited = auditedGate(gate, tab.value);
    /**
     * THE CAPABILITY GATE FIRST, ALWAYS, FOR EVERY REGISTERED TAB.
     *
     * Two things follow from running it before the allowlist rather than
     * after, and both matter more than the handful of predicate calls that
     * skipping it would save:
     *
     *   - the allowlist can only ever narrow what this returns, because it
     *     never gets asked about a tab `visible` already rejected. The "can
     *     only subtract" property is then structural, not a promise somebody
     *     has to keep;
     *   - the Proxy audit still fires for tabs the allowlist is about to drop.
     *     A predicate reading a gate key nobody defined is a programming
     *     mistake, and one person's preset must not be able to hide it from
     *     the build that would otherwise have caught it — a bug that only
     *     appears once somebody's allowlist stops covering it up is the same
     *     class of silence this whole file exists to end.
     */
    if (!tab.visible(audited)) continue;
    // ...and only now the preset. `BASE_TAB` is exempt: see its comment.
    if (allowed && tab.value !== BASE_TAB && !allowed.has(tab.value)) continue;
    out.push({
      ...tab,
      label: typeof tab.label === 'function' ? tab.label(audited) : tab.label,
    });
  }
  return out;
};

/**
 * A stable string for everything the gate says, for use as a memo dependency.
 *
 * Keys are sorted so the string does not depend on the order the literal was
 * written in, and `undefined` is folded to `null` so that adding a key and
 * leaving it unset still changes the signature — an `undefined` value would
 * otherwise be dropped by `JSON.stringify` and read as "nothing changed".
 *
 * @param {Object} gate
 * @returns {string}
 */
export const gateSignature = (gate) =>
  JSON.stringify(
    Object.keys(gate)
      .sort()
      .map((key) => [key, gate[key] === undefined ? null : gate[key]])
  );

/**
 * Which view the URL is asking for, validated against what actually exists.
 *
 * Anything unknown — a stale link, `?view=goals` on a standard board, a board
 * that has not loaded yet — falls back to the board view rather than rendering
 * a tab that is not there.
 *
 * @param {string|null} raw
 * @param {ViewTab[]} visibleTabs
 * @param {string} [fallback] - the tab to open when the URL names nothing
 *   usable; re-checked against `visibleTabs` like any other candidate
 * @returns {string}
 */
export const resolveView = (raw, visibleTabs, fallback = BASE_TAB) =>
  visibleTabs.some((t) => t.value === raw)
    ? raw
    : /**
       * The default when the URL names nothing usable.
       *
       * Its source has moved — it was seeded by a board template, and today it
       * is the reader's own per-board preset (`defaultTab`), which is why a
       * curated board can open on its scores instead of its rows. The RULE has
       * not moved, and must not be copied out to either caller: the fallback is
       * checked against the visible tabs exactly like the URL's value was, so a
       * default that was later gated off — an add-on switched off, a permission
       * lost, a tab left out of an allowlist — lands on the board rather than
       * on a blank pane. Callers pass a preference; they never pass a decision.
       */
      (visibleTabs.some((t) => t.value === fallback) ? fallback : BASE_TAB);

/**
 * What `?view=` has to SAY for the page to be showing `next`.
 *
 * `null` means delete the parameter; a string means set it to that string.
 *
 * ---- The bug this closes ----------------------------------------------------
 *
 * "The board tab" used to be expressible by SILENCE. `resolveView`'s fallback
 * was the literal board view, so every caller that wanted the rows back simply
 * deleted `?view=` — the tab bar's own click handler, the People tab's
 * group drill-down, a notification's `highlightTask`, Delivery's open-task.
 *
 * The fallback is now the reader's own `defaultTab`, and silence therefore
 * means THEIR tab. Deleting the parameter stopped meaning "go to the board" for
 * exactly the people the preset exists for, and it failed in the quietest way
 * available: the URL did not change, so nothing re-rendered, so the Board tab
 * could not be selected by clicking at all, and every deep link that clears the
 * view before revealing a row cleared it to no effect and then gave up — the
 * row never appeared, the `highlightTask` parameter was never consumed, and
 * nothing anywhere said why.
 *
 * ---- The rule ---------------------------------------------------------------
 *
 * THE EMPTY URL IS ONLY EVER ALLOWED TO MEAN THE BOARD TAB. If a preset has
 * made it mean something else, every navigation spells its tab out instead.
 *
 * Deliberately not the tempting generalisation, "delete the parameter whenever
 * `next` is what the empty URL would resolve to". That would keep URLs tidier
 * for a reader with a preset, at the price of `/boards/:id` meaning a different
 * tab for each person who opens it — which is not a link to a tab, it is a link
 * to somebody's preference, and the whole reason the view lives in the URL is
 * that it is the thing worth pasting to a colleague.
 *
 * For the overwhelming majority — every reader with no preset at all — the
 * fallback resolves to the board tab and this is the two lines it replaces:
 * `board` deletes, anything else sets.
 *
 * @param {string} next          - the tab to show
 * @param {ViewTab[]} visibleTabs - as handed to `resolveView`
 * @param {string} [fallback]     - as handed to `resolveView`; pass the SAME
 *   value, or the two disagree about what an empty URL means
 * @returns {string|null}
 */
export const viewParamFor = (next, visibleTabs, fallback = BASE_TAB) =>
  // Asked of `resolveView` rather than compared against `fallback` directly, so
  // that a preset naming a tab this board does not show (a capability lost, an
  // add-on switched off, a tab left out of the allowlist) collapses back to the
  // board here as well — one function decides what silence means, and this is a
  // question put TO it rather than a second copy of its answer.
  next === BASE_TAB && resolveView(null, visibleTabs, fallback) === BASE_TAB
    ? null
    : next;

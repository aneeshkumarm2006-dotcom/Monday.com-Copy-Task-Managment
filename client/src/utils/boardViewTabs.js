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
 * @param {ViewTab[]} tabs
 * @param {Object} gate
 * @returns {ViewTab[]} with `label` always a string
 */
export const resolveViewTabs = (tabs, gate) => {
  const out = [];
  for (const tab of tabs) {
    const audited = auditedGate(gate, tab.value);
    if (!tab.visible(audited)) continue;
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
 * @returns {string}
 */
export const resolveView = (raw, visibleTabs) =>
  visibleTabs.some((t) => t.value === raw) ? raw : 'board';
